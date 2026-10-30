// Renderer-side cloud sync primitives.
//
// Pure logic only: no Electron, no network, no filesystem. The main process
// owns HTTP and token storage; the store owns persistence. This module turns a
// local workspace into per-entity changes, applies remote changes back onto a
// workspace, and keeps the durable push queue.
//
// Entity model (matches POST /workspaces/:id/changes):
//   { id, kind, parentId, orderKey, payload }
// `payload` is the node's own JSON without children; `orderKey` is the
// zero-padded index among its siblings so a reorder or move produces a
// different change even when payloads are identical.

export const KIND = Object.freeze({
  collection: 'collection',
  folder: 'folder',
  request: 'request',
  environment: 'environment',
  globals: 'globals',
});

export const GLOBALS_ID = 'globals';
export const ORDER_KEY_WIDTH = 6;
// Synthetic collection used when a pulled folder/request references a parent
// that is not present locally (yet). Parked here rather than dropped, so a
// later pull can still resolve it once the parent arrives.
export const UNFILED_COLLECTION_ID = 'unfiled';
export const UNFILED_COLLECTION_NAME = 'Unfiled';

export const MIN_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 60000;
export const QUEUE_VERSION = 1;

// A value may legitimately be `__proto__` in server payloads. Copying it with
// `out[key] = value` would mutate the prototype, so route it through
// defineProperty.
function cloneJson(value) {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      const cloned = cloneJson(entry);
      if (key === '__proto__') {
        Object.defineProperty(out, key, {
          value: cloned,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } else {
        out[key] = cloned;
      }
    }
    return out;
  }
  return value;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a !== 'object') return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }
  return true;
}

export function orderKeyFor(index) {
  const n = Math.max(0, Math.trunc(Number(index) || 0));
  return String(n).padStart(ORDER_KEY_WIDTH, '0');
}

// Node JSON without its children. Requests have no `items`, but strip it
// defensively so a malformed node can never smuggle a subtree into a payload.
function ownPayload(node) {
  const payload = {};
  for (const [key, value] of Object.entries(node || {})) {
    if (key === 'items') continue;
    payload[key] = cloneJson(value);
  }
  return payload;
}

function flattenItems(items, parentId, push) {
  const list = Array.isArray(items) ? items : [];
  list.forEach((node, index) => {
    if (!node || node.id == null) return;
    const kind = node.type === 'folder' ? KIND.folder : KIND.request;
    push({
      id: node.id,
      kind,
      parentId,
      orderKey: orderKeyFor(index),
      payload: ownPayload(node),
    });
    if (kind === KIND.folder) flattenItems(node.items, node.id, push);
  });
}

// Flatten one workspace into backend entities. Order: collections (depth
// first), then environments, then the single globals entity.
export function flattenWorkspace(workspace) {
  const ws = workspace || {};
  const entities = [];
  const byId = Object.create(null);
  const push = (entity) => {
    entities.push(entity);
    byId[entity.id] = entity;
  };

  const collections = Array.isArray(ws.collections) ? ws.collections : [];
  collections.forEach((collection, index) => {
    if (!collection || collection.id == null) return;
    push({
      id: collection.id,
      kind: KIND.collection,
      parentId: null,
      orderKey: orderKeyFor(index),
      payload: ownPayload(collection),
    });
    flattenItems(collection.items, collection.id, push);
  });

  const environments = Array.isArray(ws.environments) ? ws.environments : [];
  environments.forEach((environment, index) => {
    if (!environment || environment.id == null) return;
    push({
      id: environment.id,
      kind: KIND.environment,
      parentId: null,
      orderKey: orderKeyFor(index),
      payload: ownPayload(environment),
    });
  });

  push({
    id: GLOBALS_ID,
    kind: KIND.globals,
    parentId: null,
    orderKey: null,
    payload: cloneJson(Array.isArray(ws.globals) ? ws.globals : []),
  });

  return { entities, byId };
}

function stateFrom(input) {
  if (!input) return { entities: [], byId: Object.create(null), revs: {} };
  if (input.byId && Array.isArray(input.entities)) {
    return { entities: input.entities, byId: input.byId, revs: input.revs || {} };
  }
  const flat = flattenWorkspace(input);
  return { ...flat, revs: input.revs || {} };
}

export function newOpId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function sameKey(a, b) {
  const left = a == null ? '' : String(a);
  const right = b == null ? '' : String(b);
  return left === right;
}

function sameParent(a, b) {
  return (a ?? null) === (b ?? null);
}

// Compare two flattened states and produce backend push changes.
//
// `prev` carries the last known server revisions (`prev.revs`). Creates get
// baseRev 0; deletes get the revision of the entity being removed. No-op
// entries are skipped. `revs` in the result is the optimistic local revision
// map after the changes are applied.
//
// Ordering is deterministic: creates/updates follow `next` (parents before
// children), deletes follow `prev` in reverse (children before parents).
export function diffEntities(prev, next, options = {}) {
  const before = stateFrom(prev);
  const after = stateFrom(next);
  const opts = typeof options === 'function' ? { newId: options } : options || {};
  const makeId = typeof opts.newId === 'function' ? opts.newId : newOpId;

  const prevById = before.byId;
  const nextById = after.byId;
  const revs = { ...before.revs };
  const changes = [];

  for (const entity of after.entities) {
    const existing = prevById[entity.id];
    if (!existing) {
      changes.push({
        opId: makeId(),
        id: entity.id,
        kind: entity.kind,
        baseRev: 0,
        payload: cloneJson(entity.payload),
        parentId: entity.parentId ?? null,
        orderKey: entity.orderKey ?? null,
        deleted: false,
      });
      revs[entity.id] = 1;
      continue;
    }
    const unchanged =
      existing.kind === entity.kind &&
      sameParent(existing.parentId, entity.parentId) &&
      sameKey(existing.orderKey, entity.orderKey) &&
      deepEqual(existing.payload, entity.payload);
    if (unchanged) continue;

    const baseRev = Number(before.revs[entity.id] ?? 0);
    changes.push({
      opId: makeId(),
      id: entity.id,
      kind: entity.kind,
      baseRev,
      payload: cloneJson(entity.payload),
      parentId: entity.parentId ?? null,
      orderKey: entity.orderKey ?? null,
      deleted: false,
    });
    revs[entity.id] = baseRev + 1;
  }

  for (let i = before.entities.length - 1; i >= 0; i -= 1) {
    const entity = before.entities[i];
    if (nextById[entity.id]) continue;
    const baseRev = Number(before.revs[entity.id] ?? 0);
    changes.push({
      opId: makeId(),
      id: entity.id,
      kind: entity.kind,
      baseRev,
      payload: null,
      parentId: null,
      orderKey: null,
      deleted: true,
    });
    delete revs[entity.id];
  }

  return { changes, revs };
}

function compareOrder(a, b) {
  const left = a.orderKey == null ? '\uffff' : String(a.orderKey);
  const right = b.orderKey == null ? '\uffff' : String(b.orderKey);
  if (left < right) return -1;
  if (left > right) return 1;
  const leftId = String(a.id);
  const rightId = String(b.id);
  if (leftId < rightId) return -1;
  if (leftId > rightId) return 1;
  return 0;
}

function removeSubtree(records, id, revs) {
  for (const record of [...records.values()]) {
    if (record.parentId === id) removeSubtree(records, record.id, revs);
  }
  records.delete(id);
  delete revs[id];
}

// Apply pulled server changes to a workspace.
//
// - Unknown ids are inserted under their `parentId`; unknown or missing
//   parents are parked in the synthetic "Unfiled" collection so nothing is
//   lost. Collections/environments stay at the workspace root.
// - Deleting a collection or folder removes its whole local subtree.
// - `revs` is advanced in place (server `rev` when present). The returned
//   workspace is a new object; the input is not mutated.
export function applyPulledChanges(workspace, changes, revs = {}) {
  const ws = workspace || {};
  const base = flattenWorkspace(ws);
  const records = new Map();
  for (const entity of base.entities) {
    records.set(entity.id, {
      id: entity.id,
      kind: entity.kind,
      parentId: entity.parentId ?? null,
      orderKey: entity.orderKey ?? null,
      payload: cloneJson(entity.payload),
    });
  }

  const list = Array.isArray(changes)
    ? changes
    : Array.isArray(changes?.changes)
      ? changes.changes
      : [];

  for (const change of list) {
    if (!change || change.id == null) continue;
    if (change.deleted) {
      removeSubtree(records, change.id, revs);
      continue;
    }
    const existing = records.get(change.id);
    const kind = change.kind || existing?.kind;
    if (!kind) continue; // A new entity without a kind cannot be placed.
    records.set(change.id, {
      id: change.id,
      kind,
      parentId: change.parentId ?? null,
      orderKey: change.orderKey ?? null,
      payload: cloneJson(change.payload ?? {}),
    });
    const previousRev = Number(revs[change.id] ?? 0);
    revs[change.id] = Number.isFinite(Number(change.rev))
      ? Number(change.rev)
      : previousRev + 1;
  }

  const byKind = (kind) => [...records.values()].filter((r) => r.kind === kind).sort(compareOrder);
  const collections = byKind(KIND.collection);
  const environments = byKind(KIND.environment);

  const containerIds = new Set();
  for (const record of records.values()) {
    if (record.kind === KIND.collection || record.kind === KIND.folder) {
      containerIds.add(record.id);
    }
  }

  const children = new Map();
  const treeRecords = [];
  for (const record of records.values()) {
    if (record.kind !== KIND.folder && record.kind !== KIND.request) continue;
    treeRecords.push(record);
    if (record.parentId != null && containerIds.has(record.parentId)) {
      const siblings = children.get(record.parentId) || [];
      siblings.push(record);
      children.set(record.parentId, siblings);
    }
  }
  for (const siblings of children.values()) siblings.sort(compareOrder);
  treeRecords.sort(compareOrder);

  // `built` records anything reachable from a collection, so the orphan pass
  // never duplicates a node. `seen` is per recursion and breaks parent cycles.
  const built = new Set();
  const buildNode = (record, seen) => {
    if (built.has(record.id) || seen.has(record.id)) return null;
    seen.add(record.id);
    const payload = cloneJson(record.payload || {});
    if (record.kind === KIND.folder) {
      const items = (children.get(record.id) || [])
        .map((child) => buildNode(child, seen))
        .filter(Boolean);
      built.add(record.id);
      return { ...payload, type: KIND.folder, items };
    }
    delete payload.items;
    built.add(record.id);
    return { ...payload, type: KIND.request };
  };

  const collectionNodes = collections.map((record) => {
    const payload = cloneJson(record.payload || {});
    delete payload.items;
    return {
      ...payload,
      items: (children.get(record.id) || [])
        .map((child) => buildNode(child, new Set()))
        .filter(Boolean),
    };
  });

  // Anything not reachable from a collection has a missing (or cyclic)
  // parent. Park it under "Unfiled" instead of dropping it. Only entities
  // whose parent is missing/not a container are roots; children stay nested
  // under them.
  const isContainer = (record) =>
    record && (record.kind === KIND.collection || record.kind === KIND.folder);
  const orphanRoots = treeRecords.filter((record) => {
    const parent = record.parentId == null ? null : records.get(record.parentId);
    return !isContainer(parent);
  });

  const orphanNodes = [];
  for (const record of orphanRoots) {
    if (built.has(record.id)) continue;
    const node = buildNode(record, new Set());
    if (node) orphanNodes.push(node);
  }
  // Remaining unbuilt records can only come from parent cycles.
  for (const record of treeRecords) {
    if (built.has(record.id)) continue;
    const node = buildNode(record, new Set());
    if (node) orphanNodes.push(node);
  }

  if (orphanNodes.length) {
    const existing = collectionNodes.findIndex((c) => c.id === UNFILED_COLLECTION_ID);
    if (existing >= 0) {
      collectionNodes[existing] = {
        ...collectionNodes[existing],
        items: [...(collectionNodes[existing].items || []), ...orphanNodes],
      };
    } else {
      collectionNodes.push({
        id: UNFILED_COLLECTION_ID,
        name: UNFILED_COLLECTION_NAME,
        description: '',
        variables: [],
        items: orphanNodes,
      });
    }
  }

  const environmentNodes = environments.map((record) => {
    const payload = cloneJson(record.payload || {});
    return {
      ...payload,
      id: record.id,
      variables: Array.isArray(payload.variables) ? payload.variables : [],
    };
  });

  const globalsRecord = records.get(GLOBALS_ID);
  const globals = Array.isArray(globalsRecord?.payload)
    ? cloneJson(globalsRecord.payload)
    : [];

  const activeEnvId =
    ws.activeEnvId != null && environmentNodes.some((env) => env.id === ws.activeEnvId)
      ? ws.activeEnvId
      : null;

  return {
    ...ws,
    collections: collectionNodes,
    environments: environmentNodes,
    globals,
    activeEnvId,
  };
}

// Split a push response into applied, conflicts (server state attached) and
// failed. Accepts either the raw `results` array or the full
// `{results, serverSeq}` envelope.
export function reconcilePushResults(payload) {
  // Accept its own output so callers can safely ack(reconcilePushResults(x)).
  if (
    payload &&
    !Array.isArray(payload) &&
    (Array.isArray(payload.applied) ||
      Array.isArray(payload.conflicts) ||
      Array.isArray(payload.failed))
  ) {
    return {
      applied: Array.isArray(payload.applied) ? payload.applied : [],
      conflicts: Array.isArray(payload.conflicts) ? payload.conflicts : [],
      failed: Array.isArray(payload.failed) ? payload.failed : [],
    };
  }
  const results = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.results)
      ? payload.results
      : [];
  const applied = [];
  const conflicts = [];
  const failed = [];
  for (const result of results) {
    if (!result || typeof result !== 'object') continue;
    if (result.conflict === true) conflicts.push(result);
    else if (result.applied === true) applied.push(result);
    else failed.push(result);
  }
  return { applied, conflicts, failed };
}

// Exponential backoff: 1s, 2s, 4s ... capped at 60s. `jitter` receives the
// capped delay and returns the delay to use (defaults to no jitter).
export function nextBackoff(attempt, jitter = (ms) => ms) {
  const n = Math.max(0, Math.floor(Number(attempt) || 0));
  const base = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** n);
  const value = Number(typeof jitter === 'function' ? jitter(base) : jitter);
  if (!Number.isFinite(value) || value < 0) return base;
  return Math.min(MAX_BACKOFF_MS, Math.round(value));
}

function normalizeQueuedItems(initial) {
  const source = Array.isArray(initial)
    ? initial
    : Array.isArray(initial?.items)
      ? initial.items
      : [];
  return source.filter(Boolean).map((item) => cloneJson(item));
}

function normalizeAttempts(initial) {
  const source = initial && !Array.isArray(initial) ? initial.attempts : null;
  const out = {};
  if (source && typeof source === 'object') {
    for (const [opId, count] of Object.entries(source)) {
      const n = Number(count);
      if (opId && Number.isFinite(n) && n > 0) out[opId] = Math.floor(n);
    }
  }
  return out;
}

// Durable pending queue. `persist(snapshot)` is called after every mutation;
// the caller stores the snapshot (the sync pass restores it via `initial`).
//
// drain() peeks without removing: an entry only leaves the queue after ack(),
// so a crash or network failure between send and ack cannot lose an edit.
export function createSyncQueue({ persist, now, newId, initial } = {}) {
  const persistFn = typeof persist === 'function' ? persist : () => {};
  const nowFn = typeof now === 'function' ? now : Date.now;
  const makeId = typeof newId === 'function' ? newId : newOpId;

  let items = normalizeQueuedItems(initial);
  const attempts = normalizeAttempts(initial);

  const snapshot = () => ({
    version: QUEUE_VERSION,
    items: cloneJson(items),
    attempts: { ...attempts },
    updatedAt: nowFn(),
  });

  const flush = () => {
    persistFn(snapshot());
  };

  const enqueue = (changes) => {
    const list = Array.isArray(changes) ? changes : changes ? [changes] : [];
    const queued = new Set(items.map((item) => item.opId).filter(Boolean));
    const added = [];
    for (const change of list) {
      if (!change || typeof change !== 'object') continue;
      const opId = change.opId || makeId();
      if (queued.has(opId)) continue;
      queued.add(opId);
      added.push({ ...cloneJson(change), opId });
    }
    if (added.length) {
      items = items.concat(added);
      flush();
    }
    return added;
  };

  const drain = (limit = Infinity) => {
    const n = Number(limit);
    const count = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : items.length;
    return cloneJson(items.slice(0, count));
  };

  const ack = (results) => {
    const { applied, conflicts, failed } = reconcilePushResults(results);
    const settled = new Set();
    for (const result of applied) if (result.opId) settled.add(result.opId);
    // Conflicts are settled too: retrying the same opId replays the stored
    // server result, so the local edit must be surfaced (not retried) and the
    // queue must move on.
    for (const result of conflicts) if (result.opId) settled.add(result.opId);

    const failedById = new Map();
    for (const result of failed) if (result.opId) failedById.set(result.opId, result);

    const retained = [];
    for (const item of items) {
      if (settled.has(item.opId)) {
        delete attempts[item.opId];
        continue;
      }
      if (failedById.has(item.opId)) {
        attempts[item.opId] = (attempts[item.opId] || 0) + 1;
      }
      retained.push(item);
    }
    items = retained;
    flush();
    return {
      applied: applied.length,
      conflicts: conflicts.length,
      failed: failed.length,
      pending: items.length,
    };
  };

  const pending = () => cloneJson(items);

  const attemptFor = (opId) => attempts[opId] || 0;

  return {
    enqueue,
    drain,
    ack,
    pending,
    snapshot,
    nextBackoff: (attempt) => nextBackoff(attempt),
    attemptFor,
  };
}
