import { describe, expect, it, vi } from 'vitest';
import { createCloudController } from '../../src/lib/cloudController.js';
import { flattenWorkspace } from '../../src/lib/cloudSync.js';

function makeWorkspace() {
  return {
    id: 'ws1',
    name: 'Demo',
    activeEnvId: 'env1',
    globals: [{ key: 'shared', value: '1', enabled: true }],
    environments: [
      {
        id: 'env1',
        name: 'Prod',
        variables: [{ key: 'baseUrl', value: 'https://api.test', enabled: true }],
      },
    ],
    collections: [
      {
        id: 'col1',
        name: 'API',
        description: '',
        variables: [],
        auth: { type: 'none' },
        preRequest: '',
        tests: '',
        items: [
          {
            id: 'fld1',
            type: 'folder',
            name: 'Users',
            items: [{ id: 'req1', type: 'request', name: 'List', method: 'GET', url: '/users' }],
          },
        ],
      },
    ],
  };
}

function defaultPush(payload) {
  return {
    ok: true,
    data: {
      results: payload.changes.map((change) => ({ opId: change.opId, applied: true })),
      serverSeq: 10,
    },
  };
}

function harness({ signedIn = true } = {}) {
  const workspace = makeWorkspace();
  const table = new Map([[workspace.id, workspace]]);
  const calls = [];
  let seq = 0;

  const cloud = {
    status: vi.fn(async () => ({
      ok: true,
      data: { signedIn, user: { id: 'user-1', email: 'dev@relay.test' } },
    })),
    login: vi.fn(async () => ({
      ok: true,
      data: { user: { id: 'user-1', email: 'dev@relay.test' } },
    })),
    register: vi.fn(async () => ({
      ok: true,
      data: { user: { id: 'user-2', email: 'new@relay.test' } },
    })),
    logout: vi.fn(async () => ({ ok: true, data: null })),
    createWorkspace: vi.fn(async ({ name }) => ({ ok: true, data: { id: 'remote-1', name } })),
    push: vi.fn(async (payload) => {
      calls.push({ method: 'push', payload });
      return defaultPush(payload);
    }),
    pull: vi.fn(async (payload) => {
      calls.push({ method: 'pull', payload });
      return { ok: true, data: { changes: [], nextSeq: payload.since, hasMore: false } };
    }),
  };

  const controller = createCloudController({
    cloud,
    getWorkspace: (id) => table.get(id) || null,
    patchWorkspace: (id, patch) => {
      const current = table.get(id);
      if (!current) return;
      const next = typeof patch === 'function' ? patch(current) : patch;
      table.set(id, { ...current, ...next });
    },
    now: () => 1000,
    newId: () => `op-${(seq += 1)}`,
  });

  // A second controller over the same persisted table simulates an app
  // restart: it starts with an empty in-memory baseline cache.
  function newController() {
    return createCloudController({
      cloud,
      getWorkspace: (id) => table.get(id) || null,
      patchWorkspace: (id, patch) => {
        const current = table.get(id);
        if (!current) return;
        const next = typeof patch === 'function' ? patch(current) : patch;
        table.set(id, { ...current, ...next });
      },
      now: () => 1000,
      newId: () => `op-${(seq += 1)}`,
    });
  }

  return { workspace, table, calls, cloud, controller, newController };
}

function editCollectionName(h, name) {
  const current = h.table.get(h.workspace.id);
  h.table.set(h.workspace.id, {
    ...current,
    collections: current.collections.map((collection) =>
      collection.id === 'col1' ? { ...collection, name } : collection
    ),
  });
}

describe('createCloudController', () => {
  it('requires a session before attaching', async () => {
    const h = harness({ signedIn: false });
    const res = await h.controller.attach(h.workspace.id);
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('unauthorized');
    expect(h.controller.status(h.workspace.id).status).toBe('signed_out');
  });

  it('attach creates the remote workspace and pushes every local entity at baseRev 0', async () => {
    const h = harness();
    await h.controller.refreshSession();

    const flat = flattenWorkspace(h.workspace);
    const res = await h.controller.attach(h.workspace.id);

    expect(res).toMatchObject({ ok: true, data: { remoteId: 'remote-1' } });
    expect(h.cloud.createWorkspace).toHaveBeenCalledWith({ name: 'Demo' });

    const push = h.cloud.push.mock.calls[0][0];
    expect(push.workspaceId).toBe('remote-1');
    expect(push.changes).toHaveLength(flat.entities.length);
    expect(push.changes.every((change) => change.baseRev === 0 && change.deleted === false)).toBe(
      true
    );
    expect(push.changes.map((change) => change.id).sort()).toEqual(
      flat.entities.map((entity) => entity.id).sort()
    );

    const saved = h.table.get(h.workspace.id);
    expect(saved.cloud).toMatchObject({
      remoteId: 'remote-1',
      cursor: 10,
      state: 'synced',
    });
    expect(saved.cloud.queueSnapshot.items).toHaveLength(0);
    expect(h.controller.status(h.workspace.id).status).toBe('synced');
  });

  it('sync pushes the pending queue before pulling until hasMore is false', async () => {
    const h = harness();
    await h.controller.refreshSession();
    await h.controller.attach(h.workspace.id);

    // Local edit: a brand-new collection.
    const current = h.table.get(h.workspace.id);
    h.table.set(h.workspace.id, {
      ...current,
      collections: [
        ...current.collections,
        { id: 'colNew', name: 'Local only', description: '', variables: [], items: [] },
      ],
    });

    h.calls.length = 0;
    let page = 0;
    h.cloud.pull.mockImplementation(async (payload) => {
      h.calls.push({ method: 'pull', payload });
      page += 1;
      if (page === 1) {
        return {
          ok: true,
          data: {
            changes: [
              {
                id: 'colRemote',
                kind: 'collection',
                parentId: null,
                orderKey: '000009',
                payload: { id: 'colRemote', name: 'From server', items: [] },
                rev: 3,
              },
            ],
            nextSeq: 12,
            hasMore: true,
          },
        };
      }
      return {
        ok: true,
        data: {
          changes: [
            {
              id: 'env1',
              kind: 'environment',
              parentId: null,
              orderKey: '000000',
              payload: { id: 'env1', name: 'Prod (remote)', variables: [] },
              rev: 2,
            },
          ],
          nextSeq: 14,
          hasMore: false,
        },
      };
    });

    const res = await h.controller.sync(h.workspace.id);
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ pulled: 2, cursor: 14, conflicts: 0, pending: 0 });

    expect(h.calls.map((entry) => entry.method)).toEqual(['push', 'pull', 'pull']);
    expect(h.cloud.push.mock.calls.at(-1)[0].changes).toEqual([
      expect.objectContaining({ id: 'colNew', baseRev: 0, deleted: false }),
    ]);
    expect(h.calls[1].payload.since).toBe(10);
    expect(h.calls[2].payload.since).toBe(12);

    const saved = h.table.get(h.workspace.id);
    expect(saved.collections.map((collection) => collection.id)).toContain('colRemote');
    expect(saved.environments[0].name).toBe('Prod (remote)');
    expect(saved.cloud.cursor).toBe(14);
    expect(saved.cloud.revs.colRemote).toBe(3);
    expect(saved.cloud.queueSnapshot.items).toHaveLength(0);
  });

  it('offline keeps the local edit queued and the workspace untouched', async () => {
    const h = harness();
    await h.controller.refreshSession();
    await h.controller.attach(h.workspace.id);
    editCollectionName(h, 'Locally renamed');

    h.cloud.push.mockImplementation(async () => ({
      ok: false,
      error: { code: 'offline', message: 'Cannot reach Relay Cloud', status: 0 },
    }));

    const failed = await h.controller.sync(h.workspace.id);
    expect(failed.ok).toBe(false);
    expect(failed.error.code).toBe('offline');

    let saved = h.table.get(h.workspace.id);
    expect(saved.cloud.state).toBe('offline');
    expect(saved.collections[0].name).toBe('Locally renamed');
    expect(saved.cloud.queueSnapshot.items).toEqual([
      expect.objectContaining({ id: 'col1', baseRev: 1, deleted: false }),
    ]);
    expect(h.controller.status(h.workspace.id)).toMatchObject({
      status: 'offline',
      pending: 1,
    });

    // The queued edit is retried as-is once the network is back.
    h.cloud.push.mockImplementation(async (payload) => {
      h.calls.push({ method: 'push', payload });
      return defaultPush(payload);
    });
    const retried = await h.controller.sync(h.workspace.id);
    expect(retried.ok).toBe(true);
    saved = h.table.get(h.workspace.id);
    expect(saved.cloud.queueSnapshot.items).toHaveLength(0);
    expect(saved.cloud.state).toBe('synced');
    expect(saved.collections[0].name).toBe('Locally renamed');
  });

  it('records push conflicts without applying the server copy locally', async () => {
    const h = harness();
    await h.controller.refreshSession();
    await h.controller.attach(h.workspace.id);
    editCollectionName(h, 'Local wins');

    h.cloud.push.mockImplementation(async (payload) => {
      h.calls.push({ method: 'push', payload });
      return {
        ok: true,
        data: {
          results: [
            {
              opId: payload.changes[0].opId,
              applied: false,
              conflict: true,
              server: { rev: 4, payload: { id: 'col1', name: 'Server wins', items: [] } },
            },
          ],
          serverSeq: 20,
        },
      };
    });

    let pulls = 0;
    h.cloud.pull.mockImplementation(async (payload) => {
      h.calls.push({ method: 'pull', payload });
      pulls += 1;
      return {
        ok: true,
        data: {
          changes: [
            {
              id: 'col1',
              kind: 'collection',
              parentId: null,
              orderKey: '000000',
              payload: { id: 'col1', name: 'Server wins', items: [] },
              rev: 4,
            },
          ],
          nextSeq: 21,
          hasMore: false,
        },
      };
    });

    const res = await h.controller.sync(h.workspace.id);
    expect(res.ok).toBe(true);
    expect(res.data.conflicts).toBe(1);
    expect(pulls).toBe(1);

    const saved = h.table.get(h.workspace.id);
    expect(saved.collections[0].name).toBe('Local wins');
    expect(saved.cloud.conflicts).toHaveLength(1);
    expect(saved.cloud.conflicts[0]).toMatchObject({
      id: 'col1',
      server: { rev: 4 },
      local: { payload: expect.objectContaining({ id: 'col1' }) },
    });
    expect(saved.cloud.revs.col1).toBe(4);
    expect(saved.cloud.cursor).toBe(21);
    expect(h.controller.status(h.workspace.id).status).toBe('conflict');

    // Dismiss keeps the local version and replays it on top of the server rev.
    const dismissed = h.controller.dismissConflicts(h.workspace.id);
    expect(dismissed.ok).toBe(true);
    expect(dismissed.data.requeued).toBe(1);
    const after = h.table.get(h.workspace.id);
    expect(after.cloud.conflicts).toHaveLength(0);
    expect(after.cloud.queueSnapshot.items).toEqual([
      expect.objectContaining({ id: 'col1', baseRev: 4, deleted: false }),
    ]);
  });

  it('detach unlinks the workspace and sync refuses to run afterwards', async () => {
    const h = harness();
    await h.controller.refreshSession();
    await h.controller.attach(h.workspace.id);

    const res = await h.controller.detach(h.workspace.id);
    expect(res.ok).toBe(true);
    expect(h.table.get(h.workspace.id).cloud).toBeNull();

    const synced = await h.controller.sync(h.workspace.id);
    expect(synced.ok).toBe(false);
    expect(synced.error.code).toBe('not_attached');
  });

  it('signs up by registering and then logging in with the device label', async () => {
    const h = harness();
    const res = await h.controller.signUp({
      name: 'Ada',
      email: 'new@relay.test',
      password: 'secret',
      deviceLabel: 'Laptop',
    });

    expect(res.ok).toBe(true);
    expect(res.data.user).toMatchObject({ id: 'user-1', email: 'dev@relay.test' });
    expect(h.cloud.register).toHaveBeenCalledWith({
      name: 'Ada',
      email: 'new@relay.test',
      password: 'secret',
    });
    expect(h.cloud.login).toHaveBeenCalledWith({
      email: 'new@relay.test',
      password: 'secret',
      deviceLabel: 'Laptop',
    });
  });

  it('reports status transitions and backoff delays', async () => {
    const h = harness();
    await h.controller.refreshSession();
    expect(h.controller.status(h.workspace.id).status).toBe('local');

    await h.controller.attach(h.workspace.id);
    expect(h.controller.status(h.workspace.id).status).toBe('synced');

    await h.controller.signOut();
    expect(h.controller.status(h.workspace.id).status).toBe('signed_out');

    expect(h.controller.nextSyncDelay(0)).toBe(1000);
    expect(h.controller.nextSyncDelay(3)).toBe(8000);
    expect(h.controller.nextSyncDelay(20)).toBe(60000);
  });
});

async function seedConflict(h, { serverName = 'Server wins', rev = 4 } = {}) {
  await h.controller.refreshSession();
  await h.controller.attach(h.workspace.id);
  editCollectionName(h, 'Local wins');

  h.cloud.push.mockImplementation(async (payload) => {
    h.calls.push({ method: 'push', payload });
    return {
      ok: true,
      data: {
        results: [
          {
            opId: payload.changes[0].opId,
            applied: false,
            conflict: true,
            server: {
              rev,
              payload: {
                id: 'col1',
                name: serverName,
                description: '',
                variables: [],
                items: [],
              },
            },
          },
        ],
        serverSeq: 20,
      },
    };
  });

  h.cloud.pull.mockImplementation(async (payload) => {
    h.calls.push({ method: 'pull', payload });
    return {
      ok: true,
      data: {
        changes: [
          {
            id: 'col1',
            kind: 'collection',
            parentId: null,
            orderKey: '000000',
            payload: { id: 'col1', name: serverName, description: '', variables: [], items: [] },
            rev,
          },
        ],
        nextSeq: 21,
        hasMore: false,
      },
    };
  });

  return h.controller.sync(h.workspace.id);
}

describe('cloud durability', () => {
  it('attach is idempotent: no backend calls and the pending queue survives', async () => {
    const h = harness();
    await h.controller.refreshSession();
    const first = await h.controller.attach(h.workspace.id);
    expect(first).toMatchObject({ ok: true, data: { remoteId: 'remote-1' } });

    editCollectionName(h, 'Pending rename');
    expect(h.controller.enqueue(h.workspace.id)).toMatchObject({ ok: true, data: { queued: 1 } });

    const createCalls = h.cloud.createWorkspace.mock.calls.length;
    const pushCalls = h.cloud.push.mock.calls.length;

    const second = await h.controller.attach(h.workspace.id);
    expect(second).toMatchObject({
      ok: true,
      already: true,
      data: { remoteId: 'remote-1', already: true },
    });
    expect(h.cloud.createWorkspace).toHaveBeenCalledTimes(createCalls);
    expect(h.cloud.push).toHaveBeenCalledTimes(pushCalls);

    const saved = h.table.get(h.workspace.id);
    expect(saved.cloud.queueSnapshot.items).toEqual([
      expect.objectContaining({ id: 'col1', deleted: false }),
    ]);
  });

  it('persists the diff baseline and recovers offline edits on a fresh controller', async () => {
    const h = harness();
    await h.controller.refreshSession();
    await h.controller.attach(h.workspace.id);

    const attached = h.table.get(h.workspace.id);
    expect(attached.cloud.baseline).toBeTruthy();
    expect(attached.cloud.baseline.entities.map((entity) => entity.id).sort()).toEqual(
      flattenWorkspace(attached).entities.map((entity) => entity.id).sort()
    );
    expect(attached.cloud.baseline.revs.col1).toBe(1);

    // "Restart": edit on disk, then a brand-new controller with no memory of
    // the previous baseline cache.
    editCollectionName(h, 'Edited while closed');
    const revived = h.newController();
    const captured = revived.captureOfflineEdits(h.workspace.id);

    expect(captured).toMatchObject({ ok: true, data: { queued: 1, captured: 1 } });
    let saved = h.table.get(h.workspace.id);
    expect(saved.cloud.queueSnapshot.items).toEqual([
      expect.objectContaining({ id: 'col1', baseRev: 1, deleted: false }),
    ]);
    expect(saved.cloud.baseline.entities.find((entity) => entity.id === 'col1').payload.name).toBe(
      'Edited while closed'
    );

    // Idempotent: the baseline advanced, so a second mount captures nothing.
    const again = revived.captureOfflineEdits(h.workspace.id);
    expect(again).toMatchObject({ ok: true, data: { queued: 0 } });
    saved = h.table.get(h.workspace.id);
    expect(saved.cloud.queueSnapshot.items).toHaveLength(1);
  });

  it('does not queue edits when no persisted baseline exists', async () => {
    const h = harness();
    await h.controller.refreshSession();
    await h.controller.attach(h.workspace.id);

    const current = h.table.get(h.workspace.id);
    const cloud = { ...current.cloud };
    delete cloud.baseline;
    h.table.set(h.workspace.id, { ...current, cloud });
    editCollectionName(h, 'Offline edit without baseline');

    const revived = h.newController();
    const res = revived.captureOfflineEdits(h.workspace.id);

    expect(res).toMatchObject({ ok: true, data: { queued: 0, skipped: true } });
    expect(h.table.get(h.workspace.id).cloud.queueSnapshot.items).toHaveLength(0);
  });

  it("resolves a conflict with 'local': replays the local side on the server rev", async () => {
    const h = harness();
    await seedConflict(h);

    expect(h.table.get(h.workspace.id).cloud.conflicts).toHaveLength(1);

    const res = h.controller.resolveConflicts(h.workspace.id, ['col1'], 'local');
    expect(res).toMatchObject({ ok: true, data: { resolved: 1, requeued: 1, mode: 'local' } });

    const saved = h.table.get(h.workspace.id);
    expect(saved.cloud.conflicts).toHaveLength(0);
    expect(saved.cloud.revs.col1).toBe(4);
    expect(saved.cloud.queueSnapshot.items).toEqual([
      expect.objectContaining({ id: 'col1', baseRev: 4, deleted: false }),
    ]);
    expect(saved.cloud.baseline.revs.col1).toBe(4);
  });

  it("resolves a conflict with 'server': applies the server payload and advances the rev", async () => {
    const h = harness();
    await seedConflict(h);

    const res = h.controller.resolveConflicts(h.workspace.id, null, 'server');
    expect(res).toMatchObject({ ok: true, data: { resolved: 1, requeued: 0, mode: 'server' } });

    const saved = h.table.get(h.workspace.id);
    expect(saved.collections[0].name).toBe('Server wins');
    expect(saved.cloud.conflicts).toHaveLength(0);
    expect(saved.cloud.revs.col1).toBe(4);
    // The applied server copy is the new baseline, so it is not re-queued.
    expect(saved.cloud.queueSnapshot.items).toHaveLength(0);
    expect(saved.cloud.baseline.entities.find((entity) => entity.id === 'col1').payload.name).toBe(
      'Server wins'
    );
  });

  it('keeps a conflict when a sync fails before the user resolves it', async () => {
    const h = harness();
    await seedConflict(h);

    // A new local edit is queued; the push then fails while offline.
    editCollectionName(h, 'Edited offline');
    expect(h.controller.enqueue(h.workspace.id)).toMatchObject({ ok: true, data: { queued: 1 } });

    h.cloud.push.mockImplementation(async () => ({
      ok: false,
      error: { code: 'offline', message: 'Cannot reach Relay Cloud', status: 0 },
    }));

    const failed = await h.controller.sync(h.workspace.id);
    expect(failed.ok).toBe(false);
    expect(failed.error.code).toBe('offline');

    const saved = h.table.get(h.workspace.id);
    expect(saved.cloud.conflicts).toHaveLength(1);
    expect(saved.cloud.conflicts[0]).toMatchObject({ id: 'col1', server: { rev: 4 } });
    expect(h.controller.status(h.workspace.id).status).toBe('conflict');
  });
});
