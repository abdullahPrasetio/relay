import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The client and token store only import `app`/`safeStorage`; tests must run
// without an Electron runtime, so both are faked here.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/relay-cloud-unit-userdata' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'keychain',
    encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
  },
}));

import { CloudError, createCloudClient } from '../../electron/cloud/client.js';
import { createTokenStore } from '../../electron/cloud/token-store.js';

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function envelope(data, status = 200) {
  return new Response(JSON.stringify({ status: true, message: 'ok', data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function failure(status, code, message) {
  return new Response(JSON.stringify({ status: false, code, message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function noContent() {
  return new Response(null, { status: 204 });
}

function fakeTokenStore(initial = null) {
  const state = { refreshToken: initial, deviceLabel: initial ? 'Test device' : null, clears: 0 };
  return {
    state,
    async get() {
      return state.refreshToken;
    },
    async set(token, { deviceLabel = '' } = {}) {
      state.refreshToken = token;
      state.deviceLabel = deviceLabel;
    },
    async clear() {
      state.refreshToken = null;
      state.deviceLabel = null;
      state.clears += 1;
    },
    async getDeviceLabel() {
      return state.deviceLabel;
    },
  };
}

function parseBody(init) {
  return init?.body ? JSON.parse(init.body) : undefined;
}

describe('createCloudClient', () => {
  it('logs in, persists only the refresh token, and reports status', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/api/v1/auth/login')) {
        return envelope({
          accessToken: 'access-1',
          refreshToken: 'refresh-1',
          user: { id: 'user-1', email: 'dev@relay.test' },
        });
      }
      throw new Error(`unexpected request: ${url}`);
    };

    const store = fakeTokenStore();
    const client = createCloudClient({
      baseUrl: 'http://relay.test',
      fetchImpl,
      tokenStore: store,
    });

    const result = await client.login({
      email: 'dev@relay.test',
      password: 'correct-horse',
      deviceLabel: 'MacBook',
    });

    expect(result).toEqual({ id: 'user-1', email: 'dev@relay.test' });
    // Tokens never reach the caller (and therefore never reach the renderer).
    expect(JSON.stringify(result)).not.toContain('access-1');
    expect(JSON.stringify(result)).not.toContain('refresh-1');

    expect(calls).toHaveLength(1);
    expect(parseBody(calls[0].init)).toMatchObject({
      email: 'dev@relay.test',
      password: 'correct-horse',
      deviceLabel: 'MacBook',
    });
    expect(store.state.refreshToken).toBe('refresh-1');
    expect(store.state.deviceLabel).toBe('MacBook');

    await expect(client.status()).resolves.toEqual({
      signedIn: true,
      user: { id: 'user-1', email: 'dev@relay.test' },
    });
  });

  it('refreshes exactly once for two concurrent 401s and retries both', async () => {
    let refreshCalls = 0;
    let workspaceCalls = 0;

    const fetchImpl = async (url, init) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/auth/login')) {
        return envelope({
          accessToken: 'access-1',
          refreshToken: 'refresh-1',
          user: { id: 'user-1' },
        });
      }
      if (pathname.endsWith('/auth/refresh')) {
        refreshCalls += 1;
        // Hold the refresh briefly so both 401s overlap it.
        await new Promise((resolve) => setTimeout(resolve, 10));
        return envelope({
          accessToken: 'access-2',
          refreshToken: 'refresh-2',
          user: { id: 'user-1' },
        });
      }
      if (pathname.endsWith('/workspaces')) {
        workspaceCalls += 1;
        const auth = init.headers.authorization;
        if (auth === 'Bearer access-1') return failure(401, 'token_expired', 'expired');
        if (auth === 'Bearer access-2') return envelope([{ id: 'ws-1', name: 'Team', role: 'owner' }]);
        throw new Error(`unexpected authorization: ${auth}`);
      }
      throw new Error(`unexpected request: ${url}`);
    };

    const store = fakeTokenStore();
    const client = createCloudClient({ baseUrl: 'http://relay.test', fetchImpl, tokenStore: store });
    await client.login({ email: 'dev@relay.test', password: 'pw' });

    const [first, second] = await Promise.all([client.listWorkspaces(), client.listWorkspaces()]);

    expect(refreshCalls).toBe(1);
    expect(workspaceCalls).toBe(4); // two 401s + two authorized retries
    expect(first).toEqual([{ id: 'ws-1', name: 'Team', role: 'owner' }]);
    expect(second).toEqual(first);
    // Rotation persisted the new refresh token.
    expect(store.state.refreshToken).toBe('refresh-2');
  });

  it('classifies fetch failures as offline and leaves credentials intact', async () => {
    const store = fakeTokenStore('refresh-1');
    const fetchImpl = async () => {
      throw new TypeError('fetch failed');
    };
    const client = createCloudClient({
      baseUrl: 'http://relay.test',
      fetchImpl,
      tokenStore: store,
      timeoutMs: 50,
    });

    const err = await client.listWorkspaces().catch((e) => e);
    expect(err).toBeInstanceOf(CloudError);
    expect(err.code).toBe('offline');
    expect(err.status).toBe(0);
    expect(store.state.refreshToken).toBe('refresh-1');
    expect(store.state.clears).toBe(0);
  });

  it('classifies a timeout/abort as offline', async () => {
    const fetchImpl = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const client = createCloudClient({
      baseUrl: 'http://relay.test',
      fetchImpl,
      tokenStore: fakeTokenStore(),
      timeoutMs: 5,
    });

    await expect(client.listWorkspaces()).rejects.toMatchObject({
      name: 'CloudError',
      code: 'offline',
    });
  });

  it('does not clear credentials when the refresh request fails offline', async () => {
    const fetchImpl = async (url, init) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/auth/login')) {
        return envelope({ accessToken: 'access-1', refreshToken: 'refresh-1', user: { id: 'u1' } });
      }
      if (pathname.endsWith('/workspaces')) {
        return failure(401, 'token_expired', 'expired');
      }
      if (pathname.endsWith('/auth/refresh')) {
        void init;
        throw new TypeError('network down');
      }
      throw new Error(`unexpected request: ${url}`);
    };

    const store = fakeTokenStore();
    const client = createCloudClient({ baseUrl: 'http://relay.test', fetchImpl, tokenStore: store });
    await client.login({ email: 'dev@relay.test', password: 'pw' });

    await expect(client.listWorkspaces()).rejects.toMatchObject({ code: 'offline' });
    expect(store.state.refreshToken).toBe('refresh-1');
    expect(store.state.clears).toBe(0);
  });

  it('passes push and pull payloads through unchanged', async () => {
    const pushData = {
      results: [{ opId: 'op-1', applied: true }],
      serverSeq: 12,
    };
    const pullData = {
      changes: [
        {
          seq: 12,
          id: 'req-1',
          kind: 'request',
          rev: 2,
          deleted: false,
          payload: { name: 'Ping' },
          parentId: 'col-1',
          orderKey: 'a0',
        },
      ],
      nextSeq: 12,
      hasMore: false,
    };
    const requests = [];

    const fetchImpl = async (url, init) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/auth/login')) {
        return envelope({ accessToken: 'access-1', refreshToken: 'refresh-1', user: { id: 'u1' } });
      }
      if (parsed.pathname.endsWith('/workspaces/ws-1/changes') && init.method === 'POST') {
        requests.push({ kind: 'push', body: parseBody(init) });
        return envelope(pushData);
      }
      if (parsed.pathname.endsWith('/workspaces/ws-1/changes') && init.method === 'GET') {
        requests.push({ kind: 'pull', search: parsed.search });
        return envelope(pullData);
      }
      throw new Error(`unexpected request: ${url}`);
    };

    const client = createCloudClient({
      baseUrl: 'http://relay.test',
      fetchImpl,
      tokenStore: fakeTokenStore(),
    });
    await client.login({ email: 'dev@relay.test', password: 'pw' });

    const changes = [{ opId: 'op-1', id: 'req-1', kind: 'request', baseRev: 1, payload: {} }];
    await expect(client.pushChanges('ws-1', changes)).resolves.toEqual(pushData);
    await expect(client.pullChanges('ws-1', { since: 7, limit: 2 })).resolves.toEqual(pullData);

    expect(requests[0]).toEqual({ kind: 'push', body: { changes } });
    expect(requests[1].kind).toBe('pull');
    expect(requests[1].search).toBe('?since=7&limit=2');
  });

  it('sends the refresh token to the server and clears storage on logout', async () => {
    const logoutBodies = [];
    const fetchImpl = async (url, init) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/auth/login')) {
        return envelope({ accessToken: 'access-1', refreshToken: 'refresh-1', user: { id: 'u1' } });
      }
      if (pathname.endsWith('/auth/logout')) {
        logoutBodies.push(parseBody(init));
        return noContent();
      }
      throw new Error(`unexpected request: ${url}`);
    };

    const store = fakeTokenStore();
    const client = createCloudClient({ baseUrl: 'http://relay.test', fetchImpl, tokenStore: store });
    await client.login({ email: 'dev@relay.test', password: 'pw' });

    await expect(client.logout()).resolves.toBeNull();
    expect(logoutBodies).toEqual([{ refreshToken: 'refresh-1' }]);
    expect(store.state.refreshToken).toBeNull();
    await expect(client.status()).resolves.toEqual({ signedIn: false, user: null });
  });

  it('signs out locally even when the logout request cannot reach the server', async () => {
    const store = fakeTokenStore('refresh-1');
    const fetchImpl = async () => {
      throw new TypeError('fetch failed');
    };
    const client = createCloudClient({
      baseUrl: 'http://relay.test',
      fetchImpl,
      tokenStore: store,
      timeoutMs: 50,
    });

    await expect(client.logout()).resolves.toBeNull();
    expect(store.state.refreshToken).toBeNull();
  });

  it('surfaces http failures with status and the parsed envelope', async () => {
    const fetchImpl = async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/auth/login')) {
        return envelope({ accessToken: 'access-1', refreshToken: 'refresh-1', user: { id: 'u1' } });
      }
      if (pathname.endsWith('/workspaces')) {
        return failure(403, 'forbidden', 'You are not a member');
      }
      throw new Error(`unexpected request: ${url}`);
    };

    const client = createCloudClient({
      baseUrl: 'http://relay.test',
      fetchImpl,
      tokenStore: fakeTokenStore(),
    });
    await client.login({ email: 'dev@relay.test', password: 'pw' });

    const err = await client.listWorkspaces().catch((e) => e);
    expect(err).toBeInstanceOf(CloudError);
    expect(err.code).toBe('http');
    expect(err.status).toBe(403);
    expect(err.envelope).toMatchObject({ code: 'forbidden' });
  });
});

describe('createTokenStore', () => {
  it('round-trips an encrypted refresh token and tolerates corruption', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-cloud-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'relay-cloud.json');
    const store = createTokenStore({ filePath });

    // Missing file = signed out, not an error.
    await expect(store.get()).resolves.toBeNull();
    await expect(store.getDeviceLabel()).resolves.toBeNull();

    await store.set('refresh-plain', { deviceLabel: 'MacBook' });
    await expect(store.get()).resolves.toBe('refresh-plain');
    await expect(store.getDeviceLabel()).resolves.toBe('MacBook');

    const raw = await readFile(filePath, 'utf8');
    expect(raw).not.toContain('refresh-plain');
    expect(JSON.parse(raw).refreshToken).toBeTruthy();

    // Corrupt JSON degrades to signed out without throwing.
    await writeFile(filePath, '{not json', 'utf8');
    await expect(store.get()).resolves.toBeNull();

    // A valid file with an empty/undecryptable token is also "signed out".
    await writeFile(filePath, JSON.stringify({ refreshToken: '' }), 'utf8');
    await expect(store.get()).resolves.toBeNull();

    await store.set('refresh-again');
    await expect(store.get()).resolves.toBe('refresh-again');

    await store.clear();
    await expect(store.get()).resolves.toBeNull();
  });
});
