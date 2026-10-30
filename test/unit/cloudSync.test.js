import { describe, expect, it } from 'vitest';
import {
  applyPulledChanges,
  createSyncQueue,
  diffEntities,
  flattenWorkspace,
  GLOBALS_ID,
  KIND,
  MAX_BACKOFF_MS,
  mergeLocalSecrets,
  nextBackoff,
  reconcilePushResults,
  sanitizeChanges,
  secretCloudSlots,
  secretValueSlots,
  UNFILED_COLLECTION_ID,
  withDecryptedSecrets,
  withEncryptedSecrets,
} from '../../src/lib/cloudSync.js';

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
            items: [
              { id: 'req1', type: 'request', name: 'List', method: 'GET', url: '/users' },
              {
                id: 'fld2',
                type: 'folder',
                name: 'Nested',
                items: [
                  { id: 'req2', type: 'request', name: 'Get', method: 'GET', url: '/users/:id' },
                ],
              },
            ],
          },
          { id: 'req3', type: 'request', name: 'Health', method: 'GET', url: '/health' },
        ],
      },
      {
        id: 'col2',
        name: 'Other',
        description: '',
        variables: [],
        auth: { type: 'none' },
        preRequest: '',
        tests: '',
        items: [],
      },
    ],
  };
}

const clone = (value) => structuredClone(value);

function flatState(workspace, revs = {}) {
  return { ...flattenWorkspace(workspace), revs: { ...revs } };
}

function ids(entities) {
  return entities.map((entity) => entity.id);
}

describe('flattenWorkspace', () => {
  it('flattens nested folders and requests with parent ids and padded order keys', () => {
    const flat = flattenWorkspace(makeWorkspace());

    expect(ids(flat.entities)).toEqual([
      'col1',
      'fld1',
      'req1',
      'fld2',
      'req2',
      'req3',
      'col2',
      'env1',
      GLOBALS_ID,
    ]);

    const folder = flat.byId.fld1;
    expect(folder).toMatchObject({
      id: 'fld1',
      kind: KIND.folder,
      parentId: 'col1',
      orderKey: '000000',
    });
    expect(flat.byId.req2.parentId).toBe('fld2');
    expect(flat.byId.req1.kind).toBe(KIND.request);
    expect(flat.byId.req1.orderKey).toBe('000000');
    expect(flat.byId.fld2.orderKey).toBe('000001');
    expect(flat.byId.req3.orderKey).toBe('000001');
    expect(flat.byId.col2.orderKey).toBe('000001');
    expect(flat.byId.col1.orderKey).toBe('000000');
  });

  it('strips children from payloads but keeps every other field', () => {
    const flat = flattenWorkspace(makeWorkspace());

    const folder = flat.byId.fld1.payload;
    expect(folder).toMatchObject({ id: 'fld1', type: 'folder', name: 'Users' });
    expect(Object.prototype.hasOwnProperty.call(folder, 'items')).toBe(false);

    const request = flat.byId.req1.payload;
    expect(request).toMatchObject({
      id: 'req1',
      type: 'request',
      name: 'List',
      method: 'GET',
      url: '/users',
    });
  });

  it('maps environments and the single globals entity', () => {
    const workspace = makeWorkspace();
    const flat = flattenWorkspace(workspace);

    expect(flat.byId.env1).toMatchObject({
      id: 'env1',
      kind: KIND.environment,
      parentId: null,
      orderKey: '000000',
    });
    expect(flat.byId.env1.payload.variables).toEqual(workspace.environments[0].variables);

    expect(flat.byId[GLOBALS_ID]).toMatchObject({
      id: GLOBALS_ID,
      kind: KIND.globals,
      parentId: null,
      orderKey: null,
    });
    expect(flat.byId[GLOBALS_ID].payload).toEqual(workspace.globals);
  });

  it('always emits a globals entity, even for an empty workspace', () => {
    const flat = flattenWorkspace({});
    expect(flat.entities).toHaveLength(1);
    expect(flat.byId[GLOBALS_ID].payload).toEqual([]);
  });
});

describe('diffEntities', () => {
  it('reports no changes when the workspace is unchanged', () => {
    const workspace = makeWorkspace();
    const prev = flatState(workspace, { req1: 3, globals: 7 });
    const { changes, revs } = diffEntities(prev, flattenWorkspace(clone(workspace)));
    expect(changes).toEqual([]);
    expect(revs).toEqual({ req1: 3, globals: 7 });
  });

  it('creates entities with baseRev 0 and injected opIds', () => {
    const next = flattenWorkspace({
      collections: [
        {
          id: 'col_new',
          name: 'New',
          items: [{ id: 'req_new', type: 'request', name: 'R', method: 'GET' }],
        },
      ],
      environments: [],
      globals: [],
    });
    let counter = 0;
    const prev = { entities: [], byId: Object.create(null), revs: {} };

    const { changes, revs } = diffEntities(prev, next, { newId: () => `op_${++counter}` });

    expect(changes.map((c) => c.opId)).toEqual(['op_1', 'op_2', 'op_3']);
    expect(changes.map((c) => c.id)).toEqual(['col_new', 'req_new', GLOBALS_ID]);
    for (const change of changes) {
      expect(change.baseRev).toBe(0);
      expect(change.deleted).toBe(false);
    }
    expect(changes[1]).toMatchObject({ kind: KIND.request, parentId: 'col_new', orderKey: '000000' });
    expect(revs).toEqual({ col_new: 1, req_new: 1, [GLOBALS_ID]: 1 });
  });

  it('updates only the changed entity and advances its rev', () => {
    const workspace = makeWorkspace();
    const prev = flatState(workspace, { req1: 3, fld1: 1, globals: 2 });
    const next = clone(workspace);
    next.collections[0].items[0].items[0].name = 'List v2';

    const { changes, revs } = diffEntities(prev, flattenWorkspace(next), {
      newId: () => 'op_update',
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      opId: 'op_update',
      id: 'req1',
      kind: KIND.request,
      baseRev: 3,
      parentId: 'fld1',
      orderKey: '000000',
      deleted: false,
    });
    expect(changes[0].payload.name).toBe('List v2');
    expect(revs.req1).toBe(4);
    expect(revs.globals).toBe(2);
  });

  it('emits orderKey changes when siblings are reordered', () => {
    const workspace = makeWorkspace();
    const prev = flatState(workspace);
    const next = clone(workspace);
    const items = next.collections[0].items;
    [items[0], items[1]] = [items[1], items[0]];

    const { changes } = diffEntities(prev, flattenWorkspace(next), {
      newId: (() => {
        let n = 0;
        return () => `op_move_${++n}`;
      })(),
    });

    const byId = Object.fromEntries(changes.map((change) => [change.id, change]));
    expect(Object.keys(byId).sort()).toEqual(['fld1', 'req3']);
    expect(byId.fld1.orderKey).toBe('000001');
    expect(byId.req3.orderKey).toBe('000000');
    expect(byId.req3.payload.name).toBe('Health');
  });

  it('creates a new request at the end without touching siblings', () => {
    const workspace = makeWorkspace();
    const prev = flatState(workspace, { req3: 5 });
    const next = clone(workspace);
    next.collections[0].items.push({
      id: 'req4',
      type: 'request',
      name: 'Create',
      method: 'POST',
      url: '/users',
    });

    const { changes, revs } = diffEntities(prev, flattenWorkspace(next), {
      newId: () => 'op_create',
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      id: 'req4',
      baseRev: 0,
      parentId: 'col1',
      orderKey: '000002',
      deleted: false,
    });
    expect(revs.req4).toBe(1);
  });

  it('emits tombstones for removed entities, children before parents', () => {
    const workspace = makeWorkspace();
    const revsMap = { fld2: 4, req2: 9 };
    const prev = flatState(workspace, revsMap);
    const next = clone(workspace);
    next.collections[0].items[0].items = [next.collections[0].items[0].items[0]];

    const { changes, revs } = diffEntities(prev, flattenWorkspace(next), {
      newId: (() => {
        let n = 0;
        return () => `op_del_${++n}`;
      })(),
    });

    expect(changes.map((c) => c.id)).toEqual(['req2', 'fld2']);
    expect(changes[0]).toMatchObject({ baseRev: 9, deleted: true, payload: null });
    expect(changes[1]).toMatchObject({ baseRev: 4, deleted: true });
    expect(revs.req2).toBeUndefined();
    expect(revs.fld2).toBeUndefined();
  });

  it('deletes a single entity without shifting its siblings', () => {
    const workspace = makeWorkspace();
    const prev = flatState(workspace, { req3: 2 });
    const next = clone(workspace);
    next.collections[0].items.pop();

    const { changes } = diffEntities(prev, flattenWorkspace(next), { newId: () => 'op' });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ id: 'req3', baseRev: 2, deleted: true });
  });
});

describe('applyPulledChanges', () => {
  it('applies updates, inserts nested new entities, environments and globals', () => {
    const workspace = makeWorkspace();
    const original = clone(workspace);
    const revs = { req1: 3, env1: 1, globals: 2 };
    const changes = [
      {
        seq: 1,
        id: 'req1',
        kind: KIND.request,
        rev: 4,
        deleted: false,
        parentId: 'fld1',
        orderKey: '000000',
        payload: { id: 'req1', type: 'request', name: 'List v2', method: 'GET', url: '/users' },
      },
      {
        seq: 2,
        id: 'fld3',
        kind: KIND.folder,
        rev: 1,
        deleted: false,
        parentId: 'fld1',
        orderKey: '000001',
        payload: { id: 'fld3', type: 'folder', name: 'New folder' },
      },
      {
        seq: 3,
        id: 'req4',
        kind: KIND.request,
        rev: 1,
        deleted: false,
        parentId: 'fld3',
        orderKey: '000000',
        payload: { id: 'req4', type: 'request', name: 'Deep', method: 'POST', url: '/users' },
      },
      {
        seq: 4,
        id: 'env2',
        kind: KIND.environment,
        rev: 1,
        deleted: false,
        parentId: null,
        orderKey: '000001',
        payload: { id: 'env2', name: 'Staging', variables: [{ key: 'a', value: 'b', enabled: true }] },
      },
      {
        seq: 5,
        id: GLOBALS_ID,
        kind: KIND.globals,
        rev: 8,
        deleted: false,
        parentId: null,
        orderKey: null,
        payload: [{ key: 'x', value: 'y', enabled: true }],
      },
      {
        seq: 6,
        id: 'req2',
        kind: KIND.request,
        rev: 2,
        deleted: true,
      },
    ];

    const next = applyPulledChanges(workspace, changes, revs);

    expect(workspace).toEqual(original); // input untouched
    expect(next).not.toBe(workspace);

    const flat = flattenWorkspace(next);
    expect(flat.byId.req1.payload.name).toBe('List v2');
    expect(flat.byId.req4).toMatchObject({ kind: KIND.request, parentId: 'fld3' });
    expect(flat.byId.fld3.parentId).toBe('fld1');
    expect(flat.byId.req2).toBeUndefined();

    const users = flat.byId.fld1;
    expect(users.orderKey).toBe('000000');
    expect(flat.byId.env2.kind).toBe(KIND.environment);
    expect(next.environments.map((env) => env.id)).toEqual(['env1', 'env2']);
    expect(next.globals).toEqual([{ key: 'x', value: 'y', enabled: true }]);

    expect(revs).toMatchObject({ req1: 4, fld3: 1, req4: 1, env2: 1, globals: 8 });
    expect(revs.req2).toBeUndefined();
    expect(next.activeEnvId).toBe('env1');
  });

  it('parks inserts with an unknown parent in the Unfiled collection', () => {
    const workspace = makeWorkspace();
    const changes = [
      {
        id: 'ghost_req',
        kind: KIND.request,
        rev: 1,
        parentId: 'missing',
        orderKey: '000000',
        payload: { id: 'ghost_req', name: 'Orphan', method: 'GET' },
      },
      {
        id: 'orphan_fld',
        kind: KIND.folder,
        rev: 1,
        parentId: 'missing',
        orderKey: '000001',
        payload: { id: 'orphan_fld', name: 'Orphan folder' },
      },
      {
        id: 'orphan_child',
        kind: KIND.request,
        rev: 1,
        parentId: 'orphan_fld',
        orderKey: '000000',
        payload: { id: 'orphan_child', name: 'Child', method: 'GET' },
      },
    ];

    const next = applyPulledChanges(workspace, changes, {});
    const flat = flattenWorkspace(next);

    const unfiled = next.collections.find((c) => c.id === UNFILED_COLLECTION_ID);
    expect(unfiled).toBeTruthy();
    expect(ids(unfiled.items).sort()).toEqual(['ghost_req', 'orphan_fld']);
    expect(flat.byId.ghost_req.parentId).toBe(UNFILED_COLLECTION_ID);
    expect(flat.byId.orphan_child.parentId).toBe('orphan_fld');
  });

  it('adds root collections and environments from pulls at the workspace root', () => {
    const workspace = makeWorkspace();
    const changes = [
      {
        id: 'col3',
        kind: KIND.collection,
        rev: 1,
        parentId: null,
        orderKey: '000002',
        payload: { id: 'col3', name: 'Third', variables: [] },
      },
      {
        id: 'env3',
        kind: KIND.environment,
        rev: 1,
        parentId: null,
        orderKey: '000002',
        payload: { id: 'env3', name: 'Third env' },
      },
    ];

    const next = applyPulledChanges(workspace, changes, {});
    expect(next.collections.map((c) => c.id)).toEqual(['col1', 'col2', 'col3']);
    expect(next.collections[2].items).toEqual([]);
    expect(next.environments.map((e) => e.id)).toEqual(['env1', 'env3']);
    expect(next.environments[1].variables).toEqual([]);
    expect(next.collections.every((c) => c.id !== UNFILED_COLLECTION_ID)).toBe(true);
  });

  it('removes the whole local subtree when a folder is deleted', () => {
    const workspace = makeWorkspace();
    const revs = { fld1: 2, req1: 2, fld2: 2, req2: 2, req3: 2 };

    const next = applyPulledChanges(
      workspace,
      [{ id: 'fld1', kind: KIND.folder, rev: 3, deleted: true }],
      revs
    );

    const flat = flattenWorkspace(next);
    expect(flat.byId.fld1).toBeUndefined();
    expect(flat.byId.req1).toBeUndefined();
    expect(flat.byId.fld2).toBeUndefined();
    expect(flat.byId.req2).toBeUndefined();
    expect(flat.byId.req3).toBeTruthy();
    expect(next.collections[0].items.map((node) => node.id)).toEqual(['req3']);
    expect(revs.fld1).toBeUndefined();
    expect(revs.req2).toBeUndefined();
    expect(revs.req3).toBe(2);
  });

  it('increments revs when the server omits rev and accepts the envelope shape', () => {
    const workspace = makeWorkspace();
    const revs = { req1: 6 };
    const next = applyPulledChanges(
      workspace,
      {
        changes: [
          {
            id: 'req1',
            kind: KIND.request,
            parentId: 'fld1',
            orderKey: '000000',
            payload: { id: 'req1', type: 'request', name: 'No rev' },
          },
        ],
      },
      revs
    );
    expect(revs.req1).toBe(7);
    expect(flattenWorkspace(next).byId.req1.payload.name).toBe('No rev');
  });
});

describe('reconcilePushResults', () => {
  it('splits applied, conflicts (with server state) and failed', () => {
    const applied = { opId: 'op_a', applied: true };
    const conflict = {
      opId: 'op_b',
      applied: false,
      conflict: true,
      server: { id: 'req1', rev: 7, payload: { name: 'server' } },
    };
    const failed = { opId: 'op_c', applied: false, error: 'validation' };

    const result = reconcilePushResults([applied, conflict, failed, null]);
    expect(result.applied).toEqual([applied]);
    expect(result.conflicts).toEqual([conflict]);
    expect(result.conflicts[0].server.payload.name).toBe('server');
    expect(result.failed).toEqual([failed]);
  });

  it('accepts the full push envelope', () => {
    const result = reconcilePushResults({
      results: [{ opId: 'op_a', applied: true }],
      serverSeq: 12,
    });
    expect(result.applied).toHaveLength(1);
    expect(result.conflicts).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it('is idempotent over its own output', () => {
    const first = reconcilePushResults([
      { opId: 'op_a', applied: true },
      { opId: 'op_b', applied: false, error: 'nope' },
    ]);
    expect(reconcilePushResults(first)).toEqual(first);
  });
});

describe('nextBackoff', () => {
  it('doubles from one second and caps at sixty', () => {
    expect(nextBackoff(0)).toBe(1000);
    expect(nextBackoff(1)).toBe(2000);
    expect(nextBackoff(5)).toBe(32000);
    expect(nextBackoff(6)).toBe(MAX_BACKOFF_MS);
    expect(nextBackoff(50)).toBe(MAX_BACKOFF_MS);
    expect(nextBackoff(-3)).toBe(1000);
  });

  it('uses the jitter hook and still enforces the cap', () => {
    expect(nextBackoff(2, (ms) => Math.round(ms * 0.5))).toBe(2000);
    expect(nextBackoff(10, () => 999999)).toBe(MAX_BACKOFF_MS);
    expect(nextBackoff(1, () => 0)).toBe(0);
  });
});

describe('createSyncQueue', () => {
  function makeQueue(initial) {
    const persisted = [];
    let counter = 0;
    let time = 1_700_000_000_000;
    const queue = createSyncQueue({
      persist: (snapshot) => persisted.push(snapshot),
      now: () => time,
      newId: () => `op_${++counter}`,
      initial,
    });
    return {
      queue,
      persisted,
      tick: () => {
        time += 1000;
        return time;
      },
    };
  }

  const change = (id) => ({ id, kind: KIND.request, baseRev: 0, deleted: false });

  it('enqueues with generated opIds, persists after every mutation and dedupes', () => {
    const { queue, persisted } = makeQueue();
    const added = queue.enqueue([change('a'), change('b')]);

    expect(added.map((item) => item.opId)).toEqual(['op_1', 'op_2']);
    expect(queue.pending()).toHaveLength(2);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ version: 1, updatedAt: 1_700_000_000_000 });
    expect(persisted[0].items).toHaveLength(2);

    const duplicate = queue.enqueue({ opId: 'op_1', ...change('a') });
    expect(duplicate).toEqual([]);
    expect(queue.pending()).toHaveLength(2);
    expect(persisted).toHaveLength(1);
  });

  it('drains without removing so a failed send cannot lose edits', () => {
    const { queue } = makeQueue();
    queue.enqueue([change('a'), change('b'), change('c')]);

    const batch = queue.drain(2);
    expect(batch.map((item) => item.id)).toEqual(['a', 'b']);
    expect(queue.pending()).toHaveLength(3);
    expect(queue.drain(0)).toEqual([]);
    expect(queue.drain()).toHaveLength(3);

    batch[0].id = 'mutated';
    expect(queue.pending()[0].id).toBe('a'); // returned copies are detached
  });

  it('acks applied and conflicts, retains failures and counts attempts', () => {
    const { queue, persisted } = makeQueue();
    queue.enqueue([change('a'), change('b'), change('c')]);

    const summary = queue.ack([
      { opId: 'op_1', applied: true },
      { opId: 'op_2', applied: false, conflict: true, server: { rev: 4 } },
      { opId: 'op_3', applied: false, error: 'boom' },
    ]);

    expect(summary).toEqual({ applied: 1, conflicts: 1, failed: 1, pending: 1 });
    expect(queue.pending().map((item) => item.id)).toEqual(['c']);
    expect(queue.attemptFor('op_3')).toBe(1);
    expect(queue.attemptFor('op_1')).toBe(0);
    expect(persisted[persisted.length - 1].attempts).toEqual({ op_3: 1 });

    queue.ack([{ opId: 'op_3', applied: false, error: 'boom again' }]);
    expect(queue.attemptFor('op_3')).toBe(2);
    expect(queue.pending()).toHaveLength(1);

    queue.ack([{ opId: 'op_3', applied: true }]);
    expect(queue.pending()).toEqual([]);
    expect(queue.attemptFor('op_3')).toBe(0);
  });

  it('keeps queued items that have no result in the ack batch', () => {
    const { queue } = makeQueue();
    queue.enqueue([change('a'), change('b')]);
    queue.ack([{ opId: 'op_1', applied: true }]);
    expect(queue.pending().map((item) => item.id)).toEqual(['b']);
  });

  it('restores pending work and attempts from a persisted snapshot', () => {
    const first = makeQueue();
    first.queue.enqueue([change('a'), change('b')]);
    first.queue.ack([
      { opId: 'op_1', applied: false, error: 'offline' },
      { opId: 'op_2', applied: true },
    ]);
    const snapshot = first.persisted[first.persisted.length - 1];

    const second = makeQueue(snapshot);
    expect(second.queue.pending().map((item) => item.id)).toEqual(['a']);
    expect(second.queue.attemptFor('op_1')).toBe(1);
    expect(second.queue.nextBackoff(second.queue.attemptFor('op_1'))).toBe(2000);
  });

  it('does not mutate the caller\'s changes when enqueueing', () => {
    const { queue } = makeQueue();
    const original = change('a');
    const frozen = Object.freeze(clone(original));
    queue.enqueue([frozen]);
    const pending = queue.pending();
    pending[0].id = 'changed';
    expect(queue.pending()[0].id).toBe('a');
  });
});

describe('secret redaction', () => {
  it('strips secret values from environment and globals payloads', () => {
    const env = {
      id: 'env1',
      name: 'Prod',
      variables: [
        { key: 'plain', value: 'ok', enabled: true },
        { key: 'token', value: 's3cr3t', type: 'secret', secretEnc: 'cipher', enabled: true },
      ],
    };
    const globals = [{ key: 'g', value: 'hidden', type: 'secret', enabled: true }];
    const changes = sanitizeChanges([
      { opId: '1', id: 'env1', kind: 'environment', payload: env },
      { opId: '2', id: 'globals', kind: 'globals', payload: globals },
    ]);
    const envToken = changes[0].payload.variables.find((v) => v.key === 'token');
    expect(envToken.value).toBe('');
    expect(envToken).not.toHaveProperty('secretEnc');
    expect(changes[1].payload[0].value).toBe('');
    expect(JSON.stringify(changes)).not.toContain('s3cr3t');
    expect(JSON.stringify(changes)).not.toContain('hidden');
  });

  it('keeps local secrets when applying a pulled payload', () => {
    const local = {
      id: 'env1',
      variables: [{ key: 'token', value: 's3cr3t', type: 'secret', secretEnc: 'cipher', enabled: true }],
    };
    const incoming = {
      id: 'env1',
      variables: [{ key: 'token', value: '', type: 'secret', enabled: true }],
    };
    const merged = mergeLocalSecrets('environment', incoming, local);
    expect(merged.variables[0].value).toBe('s3cr3t');
    expect(merged.variables[0].secretEnc).toBe('cipher');
  });

  it('prefers a decrypted incoming secret over the local copy', () => {
    const local = {
      id: 'env1',
      variables: [{ key: 'token', value: 'stale', type: 'secret', secretEnc: 'cipher', enabled: true }],
    };
    const incoming = {
      id: 'env1',
      variables: [{ key: 'token', value: 'fresh', type: 'secret', enabled: true }],
    };
    const merged = mergeLocalSecrets('environment', incoming, local);
    expect(merged.variables[0].value).toBe('fresh');
  });

  it('collects only plaintext secret rows that still need an envelope', () => {
    const changes = [
      {
        id: 'env1',
        kind: KIND.environment,
        payload: {
          id: 'env1',
          variables: [
            { key: 'plain', value: 'ok', enabled: true },
            { key: 'token', value: 's3cr3t', type: 'secret', enabled: true },
            { key: 'blank', value: '', type: 'secret', enabled: true },
            { key: 'done', value: '', type: 'secret', secretCloud: 'env-done', enabled: true },
          ],
        },
      },
      {
        id: GLOBALS_ID,
        kind: KIND.globals,
        payload: [{ key: 'shared', value: 'global-secret', type: 'secret', enabled: true }],
      },
      { id: 'del', kind: KIND.environment, deleted: true, payload: null },
    ];

    const slots = secretValueSlots(changes);
    expect(slots).toEqual([
      { changeIndex: 0, rowIndex: 1, slotIndex: 0, value: 's3cr3t' },
      { changeIndex: 1, rowIndex: 0, slotIndex: 1, value: 'global-secret' },
    ]);
  });

  it('attaches envelopes in slot order and drops the plaintext/ciphertext', () => {
    const changes = [
      {
        id: 'env1',
        kind: KIND.environment,
        payload: {
          id: 'env1',
          variables: [
            { key: 'a', value: 'one', type: 'secret', secretEnc: 'cipher-a', enabled: true },
            { key: 'b', value: '', type: 'secret', enabled: true },
            { key: 'c', value: 'three', type: 'secret', secretEnc: 'cipher-c', enabled: true },
          ],
        },
      },
    ];
    const slots = secretValueSlots(changes);
    expect(slots.map((slot) => slot.value)).toEqual(['one', 'three']);

    const secured = withEncryptedSecrets(changes, slots, ['env-one', 'env-three']);
    const rows = secured[0].payload.variables;
    expect(rows[0]).toMatchObject({ key: 'a', value: '', secretCloud: 'env-one' });
    expect(rows[0]).not.toHaveProperty('secretEnc');
    expect(rows[1]).toMatchObject({ key: 'b', value: '' });
    expect(rows[2]).toMatchObject({ key: 'c', value: '', secretCloud: 'env-three' });
    // The input changes are not mutated.
    expect(changes[0].payload.variables[0].value).toBe('one');
  });

  it('leaves a row untouched when its envelope is missing, so the guard strips it', () => {
    const changes = [
      {
        id: 'env1',
        kind: KIND.environment,
        payload: { id: 'env1', variables: [{ key: 'a', value: 'one', type: 'secret', enabled: true }] },
      },
    ];
    const slots = secretValueSlots(changes);
    const secured = withEncryptedSecrets(changes, slots, [undefined]);
    expect(secured[0].payload.variables[0]).toMatchObject({ key: 'a', value: 'one' });
    expect(sanitizeChanges(secured)[0].payload.variables[0]).toMatchObject({ key: 'a', value: '' });
  });

  it('applies decrypted values and clears the envelope, empty on failure', () => {
    const changes = [
      {
        id: 'env1',
        kind: KIND.environment,
        payload: {
          id: 'env1',
          variables: [
            { key: 'a', value: '', type: 'secret', secretCloud: 'env-a', enabled: true },
            { key: 'b', value: '', type: 'secret', secretCloud: 'env-b', enabled: true },
          ],
        },
      },
    ];
    const slots = secretCloudSlots(changes);
    expect(slots.map((slot) => slot.envelope)).toEqual(['env-a', 'env-b']);

    const opened = withDecryptedSecrets(changes, slots, ['plain-a', null]);
    const rows = opened[0].payload.variables;
    expect(rows[0]).toMatchObject({ key: 'a', value: 'plain-a' });
    expect(rows[1]).toMatchObject({ key: 'b', value: '' });
    expect(rows[0]).not.toHaveProperty('secretCloud');
    expect(rows[1]).not.toHaveProperty('secretCloud');
  });
});
