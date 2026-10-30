import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Token store / device keys import `app` and `safeStorage`; the tests must run
// without an Electron runtime, so both are faked (same pattern as
// cloudClient.test.js). Everything else is injected.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/relay-cloud-keyprovisioning-userdata' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'keychain',
    encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
  },
}));

import { CloudError } from '../../electron/cloud/client.js';
import { createTokenStore } from '../../electron/cloud/token-store.js';
import { createDeviceKeyManager } from '../../electron/cloud/device-keys.js';
import {
  createWorkspaceKeyManager,
  WorkspaceKeyError,
} from '../../electron/cloud/workspace-keys.js';
import { CLOUD_CHANNELS, registerCloudIpc } from '../../electron/cloud/ipc.js';
import * as crypto from '../../packages/core/src/crypto/index.js';

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tokenStoreFixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'relay-cloud-keys-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'relay-cloud.json');
  return { dir, filePath, store: createTokenStore({ filePath }) };
}

/**
 * In-memory stand-in for the relay-api surface used by the key manager. The
 * `keys` map mirrors the server's per-caller wrapped-key table so a second
 * `ensure()` (after a cache reset) exercises the unwrap path again.
 */
function createFakeClient({ role = 'owner', deviceKeyList = [], entries = [] } = {}) {
  const keys = new Map();
  if (entries.length > 0) keys.set('ws_1', entries);

  const calls = {
    register: [],
    put: [],
    keyReads: 0,
    workspaceReads: 0,
  };

  const client = {
    calls,
    keys,
    role,
    deviceKeyList,
    registered: null,
    workspaceError: null,

    async registerDeviceKey(payload) {
      calls.register.push(payload);
      client.registered = payload;
      return { id: 'dk_self', ...payload };
    },

    async workspaceKeys(workspaceId) {
      calls.keyReads += 1;
      return [...(keys.get(workspaceId) || [])];
    },

    async workspace(workspaceId) {
      calls.workspaceReads += 1;
      if (client.workspaceError) throw client.workspaceError;
      return { id: workspaceId, name: 'Workspace', role };
    },

    async workspaceDeviceKeys() {
      return client.deviceKeyList;
    },

    async putWorkspaceKeys(workspaceId, { version, entries: list }) {
      calls.put.push({ workspaceId, version, entries: list });
      keys.set(
        workspaceId,
        list.map((entry) => ({ ...entry, version }))
      );
      return { version };
    },
  };

  return client;
}

function deviceKeysFor(pair) {
  return { loadOrCreate: async () => pair };
}

describe('createDeviceKeyManager', () => {
  it('creates one pair per process, persists the private key encrypted, and keeps it across sign-out', async () => {
    const { filePath, store } = await tokenStoreFixture();
    const pair = crypto.generateDeviceKeyPair();
    let generated = 0;
    const cryptoStub = {
      generateDeviceKeyPair: () => {
        generated += 1;
        return pair;
      },
    };

    const manager = createDeviceKeyManager({ tokenStore: store, crypto: cryptoStub });
    const [first, second] = await Promise.all([manager.loadOrCreate(), manager.loadOrCreate()]);
    expect(first).toEqual({ publicKey: pair.publicKey, privateKey: pair.privateKey });
    expect(second).toEqual(first);
    expect(generated).toBe(1);
    expect(Buffer.from(first.publicKey, 'base64')).toHaveLength(32);
    expect(Buffer.from(first.privateKey, 'base64')).toHaveLength(32);

    // A fresh manager (as after a restart) reuses the persisted pair.
    const reloaded = createDeviceKeyManager({ tokenStore: store, crypto: cryptoStub });
    await expect(reloaded.loadOrCreate()).resolves.toEqual(first);
    expect(generated).toBe(1);

    const raw = JSON.parse(await readFile(filePath, 'utf8'));
    expect(raw.deviceKey.publicKey).toBe(first.publicKey);
    expect(raw.deviceKey.privateKey).not.toBe(first.privateKey);
    expect(Buffer.from(raw.deviceKey.privateKey, 'base64').toString('utf8')).toBe(
      `enc:${first.privateKey}`
    );

    // Signing out drops the session but must not destroy the device identity:
    // workspace keys wrapped to this device stay recoverable.
    await store.set('refresh-plain', { deviceLabel: 'MacBook' });
    expect(JSON.parse(await readFile(filePath, 'utf8')).refreshToken).not.toBe('refresh-plain');
    await store.clear();
    await expect(store.get()).resolves.toBeNull();
    await expect(store.getDeviceKey()).resolves.toEqual(first);
    expect(JSON.parse(await readFile(filePath, 'utf8')).refreshToken).toBeUndefined();
  });

  it('does not cache a pair that could not be persisted', async () => {
    const pair = crypto.generateDeviceKeyPair();
    let attempts = 0;
    const tokenStore = {
      async getDeviceKey() {
        return null;
      },
      async setDeviceKey() {
        attempts += 1;
        throw new Error('secure storage is unavailable');
      },
    };
    const manager = createDeviceKeyManager({
      tokenStore,
      crypto: { generateDeviceKeyPair: () => pair },
    });

    await expect(manager.loadOrCreate()).rejects.toThrow(/secure storage/);
    await expect(manager.loadOrCreate()).rejects.toThrow(/secure storage/);
    expect(attempts).toBe(2);
  });
});

describe('createWorkspaceKeyManager', () => {
  it('registers the device once and unwraps the newest key addressed to it', async () => {
    const own = crypto.generateDeviceKeyPair();
    const other = crypto.generateDeviceKeyPair();
    const currentKey = crypto.generateWorkspaceKey();
    const previousKey = crypto.generateWorkspaceKey();

    const entries = [
      // The newest version is wrapped once per active device: the entry for
      // another device fails to unwrap and the matching one is used.
      {
        deviceKeyId: 'dk_other',
        version: 3,
        wrappedKey: crypto.wrapWorkspaceKey({
          workspaceKey: crypto.generateWorkspaceKey(),
          recipientPublicKey: other.publicKey,
        }),
      },
      {
        deviceKeyId: 'dk_self',
        version: 3,
        wrappedKey: crypto.wrapWorkspaceKey({
          workspaceKey: currentKey,
          recipientPublicKey: own.publicKey,
        }),
      },
      {
        deviceKeyId: 'dk_self',
        version: 2,
        wrappedKey: crypto.wrapWorkspaceKey({
          workspaceKey: previousKey,
          recipientPublicKey: own.publicKey,
        }),
      },
    ];

    const client = createFakeClient({ role: 'editor', entries });
    const manager = createWorkspaceKeyManager({
      client,
      deviceKeys: deviceKeysFor(own),
      crypto,
    });

    const state = await manager.ensure('ws_1');
    expect(state.ready).toBe(true);
    expect(state.version).toBe(3);
    expect(state.key.equals(currentKey)).toBe(true);

    expect(client.calls.register).toHaveLength(1);
    expect(client.calls.register[0].publicKey).toBe(own.publicKey);
    expect(client.calls.register[0].label.startsWith(process.platform)).toBe(true);
    expect(client.calls.put).toHaveLength(0);

    // Cached: no second registration or key read.
    await manager.ensure('ws_1');
    expect(client.calls.register).toHaveLength(1);
    expect(client.calls.keyReads).toBe(1);
  });

  it('does not fall back to an older key version when the newest set excludes this device', async () => {
    const own = crypto.generateDeviceKeyPair();
    const other = crypto.generateDeviceKeyPair();
    const entries = [
      {
        deviceKeyId: 'dk_self',
        version: 2,
        wrappedKey: crypto.wrapWorkspaceKey({
          workspaceKey: crypto.generateWorkspaceKey(),
          recipientPublicKey: own.publicKey,
        }),
      },
      {
        deviceKeyId: 'dk_other',
        version: 3,
        wrappedKey: crypto.wrapWorkspaceKey({
          workspaceKey: crypto.generateWorkspaceKey(),
          recipientPublicKey: other.publicKey,
        }),
      },
    ];

    const client = createFakeClient({ role: 'editor', entries });
    const manager = createWorkspaceKeyManager({
      client,
      deviceKeys: deviceKeysFor(own),
      crypto,
    });

    await expect(manager.ensure('ws_1')).resolves.toEqual({
      ready: false,
      version: null,
      reason: 'waiting_key',
    });
    expect(client.calls.put).toHaveLength(0);
  });

  it('bootstraps version 1 wrapping the key for every active device when an admin has no key', async () => {
    const me = crypto.generateDeviceKeyPair();
    const teammate = crypto.generateDeviceKeyPair();
    const deviceKeyList = [
      { id: 'dk_teammate', userId: 'u2', publicKey: teammate.publicKey, label: 'linux-web' },
      { id: 'dk_self', userId: 'u1', publicKey: me.publicKey, label: 'mac' },
      { id: 'dk_self', userId: 'u1', publicKey: me.publicKey, label: 'duplicate' },
      { id: 'dk_broken', userId: 'u3', publicKey: '', label: 'no-public-key' },
    ];

    const client = createFakeClient({ role: 'owner', deviceKeyList });
    const manager = createWorkspaceKeyManager({
      client,
      deviceKeys: deviceKeysFor(me),
      crypto,
    });

    const state = await manager.ensure('ws_1');
    expect(state.ready).toBe(true);
    expect(state.version).toBe(1);
    expect(state.key).toHaveLength(32);

    expect(client.calls.put).toHaveLength(1);
    const [put] = client.calls.put;
    expect(put.workspaceId).toBe('ws_1');
    expect(put.version).toBe(1);
    expect(put.entries.map((entry) => entry.deviceKeyId).sort()).toEqual([
      'dk_self',
      'dk_teammate',
    ]);

    for (const entry of put.entries) {
      expect(Buffer.from(entry.wrappedKey, 'base64')).toHaveLength(92);
    }
    const selfEntry = put.entries.find((entry) => entry.deviceKeyId === 'dk_self');
    const teammateEntry = put.entries.find((entry) => entry.deviceKeyId === 'dk_teammate');
    expect(
      crypto
        .unwrapWorkspaceKey({ wrappedKey: selfEntry.wrappedKey, privateKey: me.privateKey })
        .equals(state.key)
    ).toBe(true);
    expect(
      crypto
        .unwrapWorkspaceKey({
          wrappedKey: teammateEntry.wrappedKey,
          privateKey: teammate.privateKey,
        })
        .equals(state.key)
    ).toBe(true);

    // After a cache reset the wrapped key written above unwraps; registration
    // is still a one-time operation.
    manager.reset('ws_1');
    const reread = await manager.ensure('ws_1');
    expect(reread.ready).toBe(true);
    expect(reread.version).toBe(1);
    expect(reread.key.equals(state.key)).toBe(true);
    expect(client.calls.register).toHaveLength(1);
    // The re-read adopts the key and re-shares it (idempotent upsert).
    expect(client.calls.put).toHaveLength(2);
    expect(client.calls.put[1].version).toBe(1);
    expect(client.calls.put[1].entries.map((entry) => entry.deviceKeyId).sort()).toEqual([
      'dk_self',
      'dk_teammate',
    ]);
  });

  it('waits on an existing key set and is shared by a member device', async () => {
    const me = crypto.generateDeviceKeyPair();
    const second = crypto.generateDeviceKeyPair();
    const client = createFakeClient({
      role: 'owner',
      deviceKeyList: [{ id: 'dk_self', userId: 'u1', publicKey: me.publicKey, label: 'mac' }],
    });
    const first = createWorkspaceKeyManager({
      client,
      deviceKeys: deviceKeysFor(me),
      crypto,
    });
    const state = await first.ensure('ws_1');
    expect(state.ready).toBe(true);

    // A second device registers with the server; it has no wrapped entry yet
    // and must not create a new version (that would orphan ciphertext).
    client.deviceKeyList = [
      { id: 'dk_self', userId: 'u1', publicKey: me.publicKey, label: 'mac' },
      { id: 'dk_second', userId: 'u1', publicKey: second.publicKey, label: 'linux' },
    ];
    const secondManager = createWorkspaceKeyManager({
      client,
      deviceKeys: deviceKeysFor(second),
      crypto,
    });
    await expect(secondManager.ensure('ws_1')).resolves.toEqual({
      ready: false,
      version: null,
      reason: 'waiting_key',
    });

    // The first device re-reads (cache reset) and shares the same key.
    first.reset('ws_1');
    const shared = await first.ensure('ws_1');
    expect(shared.ready).toBe(true);

    secondManager.reset('ws_1');
    const secondState = await secondManager.ensure('ws_1');
    expect(secondState.ready).toBe(true);
    expect(secondState.version).toBe(shared.version);
    expect(secondState.key.equals(shared.key)).toBe(true);
  });

  it('rotates to the next version with a fresh key wrapped for current member devices only', async () => {
    const me = crypto.generateDeviceKeyPair();
    const teammate = crypto.generateDeviceKeyPair();
    const removed = crypto.generateDeviceKeyPair();
    const client = createFakeClient({
      role: 'owner',
      deviceKeyList: [
        { id: 'dk_self', userId: 'u1', publicKey: me.publicKey, label: 'mac' },
        { id: 'dk_teammate', userId: 'u2', publicKey: teammate.publicKey, label: 'linux' },
        { id: 'dk_removed', userId: 'u3', publicKey: removed.publicKey, label: 'removed' },
      ],
    });
    const manager = createWorkspaceKeyManager({
      client,
      deviceKeys: deviceKeysFor(me),
      crypto,
    });

    const first = await manager.ensure('ws_1');
    expect(first.ready).toBe(true);
    expect(first.version).toBe(1);

    // The removed member no longer appears in the active device-key list.
    client.deviceKeyList = client.deviceKeyList.filter((entry) => entry.id !== 'dk_removed');

    const rotated = await manager.rotate('ws_1');
    expect(rotated).toMatchObject({ ready: true, version: 2 });
    expect(rotated.key).toHaveLength(32);
    expect(rotated.key.equals(first.key)).toBe(false);

    const put = client.calls.put[client.calls.put.length - 1];
    expect(put.workspaceId).toBe('ws_1');
    expect(put.version).toBe(2);
    expect(put.entries.map((entry) => entry.deviceKeyId).sort()).toEqual([
      'dk_self',
      'dk_teammate',
    ]);

    const selfEntry = put.entries.find((entry) => entry.deviceKeyId === 'dk_self');
    const teammateEntry = put.entries.find((entry) => entry.deviceKeyId === 'dk_teammate');
    expect(
      crypto
        .unwrapWorkspaceKey({ wrappedKey: selfEntry.wrappedKey, privateKey: me.privateKey })
        .equals(rotated.key)
    ).toBe(true);
    expect(
      crypto
        .unwrapWorkspaceKey({
          wrappedKey: teammateEntry.wrappedKey,
          privateKey: teammate.privateKey,
        })
        .equals(rotated.key)
    ).toBe(true);

    // The removed device has no entry anywhere in the stored set.
    expect(client.keys.get('ws_1').some((entry) => entry.deviceKeyId === 'dk_removed')).toBe(
      false
    );

    // The cached fast path serves the rotated key, never the previous one.
    const after = await manager.ensure('ws_1');
    expect(after.version).toBe(2);
    expect(after.key.equals(rotated.key)).toBe(true);
    expect(after.key.equals(first.key)).toBe(false);
  });

  it('adopts a newer version after an admin rotation once the recheck interval elapses', async () => {
    vi.useFakeTimers();
    try {
      const me = crypto.generateDeviceKeyPair();
      const client = createFakeClient({
        role: 'owner',
        deviceKeyList: [{ id: 'dk_self', userId: 'u1', publicKey: me.publicKey, label: 'mac' }],
      });
      const admin = createWorkspaceKeyManager({
        client,
        deviceKeys: deviceKeysFor(me),
        crypto,
      });
      const before = await admin.ensure('ws_1');
      expect(before.version).toBe(1);

      // A second instance (fresh process) caches the same version.
      const stale = createWorkspaceKeyManager({
        client,
        deviceKeys: deviceKeysFor(me),
        crypto,
      });
      const cached = await stale.ensure('ws_1');
      expect(cached.version).toBe(1);
      expect(cached.key.equals(before.key)).toBe(true);

      const rotated = await admin.rotate('ws_1');
      expect(rotated.version).toBe(2);

      // Within the recheck interval the cached key is served as-is.
      const stillCached = await stale.ensure('ws_1');
      expect(stillCached.version).toBe(1);
      expect(stillCached.key.equals(before.key)).toBe(true);

      vi.setSystemTime(Date.now() + 60_000);

      const adopted = await stale.ensure('ws_1');
      expect(adopted.version).toBe(2);
      expect(adopted.key.equals(rotated.key)).toBe(true);
      expect(adopted.key.equals(before.key)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses to rotate before this device has a ready key', async () => {
    const me = crypto.generateDeviceKeyPair();
    const client = createFakeClient({ role: 'viewer' });
    const manager = createWorkspaceKeyManager({
      client,
      deviceKeys: deviceKeysFor(me),
      crypto,
    });

    await expect(manager.ensure('ws_1')).resolves.toEqual({
      ready: false,
      version: null,
      reason: 'waiting_key',
    });

    const error = await manager.rotate('ws_1').catch((err) => err);
    expect(error).toBeInstanceOf(WorkspaceKeyError);
    expect(error.code).toBe('waiting_key');
    expect(client.calls.put).toHaveLength(0);
  });

  it('reports waiting_key for a non-admin without a key and refuses to encrypt', async () => {
    const me = crypto.generateDeviceKeyPair();
    const client = createFakeClient({ role: 'viewer' });
    const manager = createWorkspaceKeyManager({
      client,
      deviceKeys: deviceKeysFor(me),
      crypto,
    });

    await expect(manager.ensure('ws_1')).resolves.toEqual({
      ready: false,
      version: null,
      reason: 'waiting_key',
    });
    expect(client.calls.put).toHaveLength(0);

    const error = await manager.encrypt('ws_1', { token: 'x' }).catch((err) => err);
    expect(error).toBeInstanceOf(WorkspaceKeyError);
    expect(error.code).toBe('waiting_key');

    // Waiting is not cached, so a later admin wrap is picked up.
    expect(client.calls.keyReads).toBeGreaterThan(1);
  });

  it('maps membership failures to stable reasons', async () => {
    const me = crypto.generateDeviceKeyPair();

    const forbidden = createFakeClient({ role: 'viewer' });
    forbidden.workspaceKeys = async () => {
      throw new CloudError('http', 'Forbidden', { status: 403 });
    };
    const notMember = createWorkspaceKeyManager({
      client: forbidden,
      deviceKeys: deviceKeysFor(me),
      crypto,
    });
    await expect(notMember.ensure('ws_1')).resolves.toEqual({
      ready: false,
      version: null,
      reason: 'not_member',
    });

    const missing = createFakeClient({ role: 'viewer' });
    missing.workspaceKeys = async () => {
      throw new CloudError('http', 'Not found', { status: 404 });
    };
    const noWorkspace = createWorkspaceKeyManager({
      client: missing,
      deviceKeys: deviceKeysFor(me),
      crypto,
    });
    await expect(noWorkspace.ensure('ws_1')).resolves.toEqual({
      ready: false,
      version: null,
      reason: 'workspace_not_found',
    });

    // Transport failures are not membership answers and must surface.
    const offline = createFakeClient({ role: 'viewer' });
    offline.workspaceKeys = async () => {
      throw new CloudError('offline', 'Cannot reach Relay Cloud');
    };
    const unreachable = createWorkspaceKeyManager({
      client: offline,
      deviceKeys: deviceKeysFor(me),
      crypto,
    });
    await expect(unreachable.ensure('ws_1')).rejects.toMatchObject({ code: 'offline' });
  });

  it('round-trips secret values and yields null only for undecryptable envelopes', async () => {
    const me = crypto.generateDeviceKeyPair();
    const workspaceKey = crypto.generateWorkspaceKey();
    const entries = [
      {
        deviceKeyId: 'dk_self',
        version: 4,
        wrappedKey: crypto.wrapWorkspaceKey({
          workspaceKey,
          recipientPublicKey: me.publicKey,
        }),
      },
    ];

    const client = createFakeClient({ role: 'editor', entries });
    const manager = createWorkspaceKeyManager({
      client,
      deviceKeys: deviceKeysFor(me),
      crypto,
    });

    const envelopes = await manager.encrypt('ws_1', {
      token: 's3cr3t',
      empty: '',
      blank: null,
      object: undefined,
    });
    expect(Object.keys(envelopes).sort()).toEqual(['empty', 'token']);

    const values = await manager.decrypt('ws_1', {
      token: envelopes.token,
      empty: envelopes.empty,
      corrupt: 'not-json',
      foreign: crypto.encryptSecretValue(crypto.generateWorkspaceKey(), 'nope'),
      missing: null,
    });
    expect(values.token).toBe('s3cr3t');
    expect(values.empty).toBe('');
    expect(values.corrupt).toBeNull();
    expect(values.foreign).toBeNull();
    expect(values.missing).toBeNull();

    // The renderer batches secret rows positionally; array order is preserved
    // and failures stay aligned as null.
    const batch = await manager.encrypt('ws_1', ['one', 'two']);
    expect(batch).toHaveLength(2);
    expect(batch.every((envelope) => typeof envelope === 'string')).toBe(true);
    await expect(
      manager.decrypt('ws_1', [batch[0], 'garbage', batch[1]])
    ).resolves.toEqual(['one', null, 'two']);
  });
});

describe('cloud crypto IPC contract', () => {
  it('returns status/envelopes/values without exposing key material', async () => {
    const handlers = new Map();
    const ipcMain = {
      handle: (channel, fn) => handlers.set(channel, fn),
      removeHandler: () => {},
    };
    const workspaceKeys = {
      async ensure() {
        return { ready: true, version: 3, key: Buffer.alloc(32, 7) };
      },
      async encrypt() {
        return { token: 'envelope' };
      },
      async decrypt() {
        return { token: 'plaintext', broken: null };
      },
      async rotate() {
        return { ready: true, version: 4, key: Buffer.alloc(32, 7) };
      },
      reset: vi.fn(),
    };

    registerCloudIpc({ ipcMain, client: {}, workspaceKeys });

    expect(CLOUD_CHANNELS).toEqual(
      expect.arrayContaining([
        'cloud:crypto-status',
        'cloud:encrypt-secrets',
        'cloud:decrypt-secrets',
        'cloud:rotate-workspace-key',
      ])
    );

    const status = await handlers.get('cloud:crypto-status')({}, { workspaceId: 'ws_1' });
    expect(status).toEqual({
      ok: true,
      data: { ready: true, version: 3, reason: null },
    });
    expect(JSON.stringify(status)).not.toContain('key');

    const encrypted = await handlers.get('cloud:encrypt-secrets')(
      {},
      { workspaceId: 'ws_1', values: { token: 's3cr3t' } }
    );
    expect(encrypted).toEqual({ ok: true, data: { envelopes: { token: 'envelope' } } });

    const decrypted = await handlers.get('cloud:decrypt-secrets')(
      {},
      { workspaceId: 'ws_1', envelopes: { token: 'envelope', broken: 'x' } }
    );
    expect(decrypted).toEqual({
      ok: true,
      data: { values: { token: 'plaintext', broken: null } },
    });

    const rotated = await handlers.get('cloud:rotate-workspace-key')(
      {},
      { workspaceId: 'ws_1' }
    );
    expect(rotated).toEqual({ ok: true, data: { ready: true, version: 4 } });
    expect(JSON.stringify(rotated)).not.toContain('key');

    // Without a key manager the channels still answer, with a stable error.
    registerCloudIpc({ ipcMain, client: {}, workspaceKeys: null });
    const unavailable = await handlers.get('cloud:crypto-status')({}, { workspaceId: 'ws_1' });
    expect(unavailable.ok).toBe(false);
    expect(unavailable.error.code).toBe('unavailable');

    // Rotation before a ready key surfaces the typed reason through IPC.
    registerCloudIpc({
      ipcMain,
      client: {},
      workspaceKeys: {
        async rotate() {
          throw new WorkspaceKeyError('waiting_key', 'Workspace key is not available');
        },
      },
    });
    const refused = await handlers.get('cloud:rotate-workspace-key')(
      {},
      { workspaceId: 'ws_1' }
    );
    expect(refused).toMatchObject({ ok: false, error: { code: 'waiting_key' } });
  });
});
