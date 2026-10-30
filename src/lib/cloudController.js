// Renderer-side cloud orchestration.
//
// No React, no Electron, no direct network: every side effect arrives through
// the injected dependencies, so this module is testable with a fake cloud and
// an in-memory workspace table.
//
//   cloud           window.api.cloud (or a fake with the same methods)
//   getWorkspace    (id) => workspace | null
//   patchWorkspace  (id, patch) => void; merges `patch` into the workspace
//   now             () => epoch ms used for timestamps
//   newId           () => unique op id (defaults to the sync engine's)
//
// Workspace shape owned by this module (persisted by the store):
//   workspace.cloud = {
//     remoteId, cursor, revs, queueSnapshot, conflicts, state, lastError, ...
//   }
//
// Method results are envelopes: { ok: true, data } or { ok: false, error }.
// `error` is always { code, message, status }.

import {
  applyPulledChanges,
  createSyncQueue,
  diffEntities,
  flattenWorkspace,
  nextBackoff,
  reconcilePushResults,
} from './cloudSync.js';

export const SYNC_STATUS = Object.freeze({
  local: 'local',
  syncing: 'syncing',
  synced: 'synced',
  offline: 'offline',
  conflict: 'conflict',
  signedOut: 'signed_out',
});

// Pull is cursor-based; batching keeps a single response small while the loop
// below still drains the full history.
export const PULL_LIMIT = 500;
// Defensive cap: never let a misbehaving server keep `hasMore` true forever.
const PULL_PAGES_MAX = 200;
// Version of the persisted diff baseline stored at workspace.cloud.baseline.
export const BASELINE_VERSION = 1;

function fail(code, message, status = 0) {
  return { ok: false, error: { code, message, status } };
}

function normalizeError(input) {
  if (!input) return { code: 'internal', message: 'Cloud request failed', status: 0 };
  if (typeof input === 'string') return { code: 'internal', message: input, status: 0 };
  return {
    code: input.code || 'internal',
    message: input.message || 'Cloud request failed',
    status: Number(input.status) || 0,
  };
}

function isEnvelope(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof value.ok === 'boolean' &&
    ('data' in value || 'error' in value)
  );
}

// Accept both the IPC envelope ({ok,data}/{ok,error}) and a bare payload.
function unwrap(value) {
  if (!isEnvelope(value)) return { ok: true, data: value };
  if (value.ok) return { ok: true, data: value.data };
  return { ok: false, error: normalizeError(value.error) };
}

function cloudConfig(workspace) {
  const cfg = workspace?.cloud;
  return cfg && typeof cfg === 'object' && cfg.remoteId ? cfg : null;
}

function uniqueConflicts(list) {
  const byKey = new Map();
  for (const conflict of list) {
    if (!conflict || conflict.id == null) continue;
    byKey.set(`${conflict.opId || ''}:${conflict.id}`, conflict);
  }
  return [...byKey.values()];
}

export function createCloudController({
  cloud = null,
  getWorkspace = () => null,
  patchWorkspace = () => {},
  now = Date.now,
  newId,
} = {}) {
  const clock = typeof now === 'function' ? now : Date.now;
  const makeId = typeof newId === 'function' ? newId : null;
  const canCall = (method) => !!cloud && typeof cloud[method] === 'function';

  // Session is intentionally kept out of the persisted workspace data: tokens
  // live in the main process, and a stale "signed in" flag must not leak.
  let session = { signedIn: false, user: null, checked: false };

  // Last flattened state used to compute local diffs. The map is a cache of
  // workspace.cloud.baseline: every save writes the latest snapshot back so a
  // restarted app can diff against the server state it last knew about.
  const baselines = new Map();
  // Workspaces with an attach/sync in flight. Serializes network passes so two
  // queue writers cannot overwrite each other's persisted snapshot.
  const syncing = new Set();

  function snapshotBaseline(entry) {
    if (!entry) return null;
    return {
      version: BASELINE_VERSION,
      entities: entry.entities.map((entity) => ({ ...entity })),
      revs: { ...(entry.revs || {}) },
    };
  }

  function setBaseline(workspaceId, base) {
    const entry = {
      entities: Array.isArray(base.entities) ? base.entities : [],
      byId: base.byId && typeof base.byId === 'object' ? base.byId : null,
      revs: { ...(base.revs || {}) },
      // `persisted` distinguishes a baseline restored from the workspace from
      // one derived from the current state on first use: offline edits are
      // only captured against a baseline that really existed before.
      persisted: !!base.persisted,
    };
    if (!entry.byId) {
      entry.byId = Object.create(null);
      for (const entity of entry.entities) {
        if (entity && entity.id != null) entry.byId[entity.id] = entity;
      }
    }
    baselines.set(workspaceId, entry);
    return entry;
  }

  // First use of a workspace in this process: restore the persisted baseline
  // (server state as of the last successful pass) or, when there is none,
  // derive one from the current workspace so later edits can still be diffed.
  function hydrateBaseline(workspaceId, cfg = null) {
    const cached = baselines.get(workspaceId);
    if (cached) return cached;
    const workspace = getWorkspace(workspaceId);
    if (!workspace) return null;
    const config = cfg || cloudConfig(workspace);
    const stored = config?.baseline;
    if (stored && Array.isArray(stored.entities)) {
      return setBaseline(workspaceId, {
        entities: stored.entities,
        revs: stored.revs || config?.revs || {},
        persisted: true,
      });
    }
    const flat = flattenWorkspace(workspace);
    return setBaseline(workspaceId, {
      entities: flat.entities,
      byId: flat.byId,
      revs: config?.revs || {},
      persisted: false,
    });
  }

  function persistBaseline(workspaceId, cfg) {
    const entry = baselines.get(workspaceId);
    const snapshot = snapshotBaseline(entry);
    if (snapshot) cfg.baseline = snapshot;
    else delete cfg.baseline;
    return snapshot;
  }

  function lock(workspaceId, run) {
    if (syncing.has(workspaceId)) {
      return Promise.resolve(fail('busy', 'A cloud sync is already running for this workspace.'));
    }
    syncing.add(workspaceId);
    return Promise.resolve()
      .then(run)
      .finally(() => syncing.delete(workspaceId));
  }

  async function call(method, payload) {
    if (!canCall(method)) {
      return fail('unavailable', 'Cloud sync requires the Relay desktop app.');
    }
    try {
      return unwrap(await cloud[method](payload));
    } catch (err) {
      return { ok: false, error: normalizeError(err) };
    }
  }

  function save(workspaceId, cfg, extra = {}) {
    // Every persisted config carries the current diff baseline so a reload can
    // resume from server state instead of silently dropping offline edits.
    persistBaseline(workspaceId, cfg);
    patchWorkspace(workspaceId, {
      ...extra,
      cloud: { ...cfg, updatedAt: clock() },
    });
  }

  function queueFor(workspaceId, cfg) {
    return createSyncQueue({
      persist: (snapshot) => {
        cfg.queueSnapshot = snapshot;
        save(workspaceId, cfg);
      },
      now: clock,
      newId: makeId || undefined,
      initial: cfg.queueSnapshot,
    });
  }

  function diffOptions() {
    return makeId ? { newId: makeId } : {};
  }

  // Flatten the workspace and enqueue anything that changed since the last
  // snapshot. Returns the generated changes (also useful for tests).
  function collect(workspaceId, cfg) {
    const workspace = getWorkspace(workspaceId);
    if (!workspace) return [];
    const flat = flattenWorkspace(workspace);
    const base = baselines.get(workspaceId) || hydrateBaseline(workspaceId, cfg);
    if (!base) return [];
    const diff = diffEntities(base, flat, diffOptions());
    setBaseline(workspaceId, {
      entities: flat.entities,
      byId: flat.byId,
      revs: diff.revs,
      persisted: base.persisted,
    });
    // The queue now holds these changes, so later diffs must build on their
    // optimistic revisions. A push response may refine them with server revs.
    cfg.revs = { ...diff.revs };
    return diff.changes;
  }

  // Push the whole pending queue. On a network/transport failure nothing is
  // acknowledged, so the queue (and the local workspace) is left untouched.
  async function pushQueue(workspaceId, cfg, queue) {
    const drained = queue.drain();
    if (!drained.length) return { ok: true, data: { applied: 0, pending: 0, conflicts: 0 } };

    const response = await call('push', { workspaceId: cfg.remoteId, changes: drained });
    if (!response.ok) return response;

    const data = response.data;
    const { applied, conflicts, failed } = reconcilePushResults(data);
    const drainedByOp = new Map(drained.map((item) => [item.opId, item]));

    for (const result of applied) {
      if (result?.id != null && result.rev != null) {
        cfg.revs[result.id] = Number(result.rev);
      }
    }
    if (data && data.serverSeq != null && Number.isFinite(Number(data.serverSeq))) {
      cfg.cursor = Math.max(Number(cfg.cursor) || 0, Number(data.serverSeq));
    }

    if (conflicts.length) {
      const next = Array.isArray(cfg.conflicts) ? [...cfg.conflicts] : [];
      for (const result of conflicts) {
        const item = drainedByOp.get(result.opId) || null;
        const id = result.id ?? item?.id;
        if (id == null) continue;
        if (result.server?.rev != null) cfg.revs[id] = Number(result.server.rev);
        next.push({
          opId: result.opId || item?.opId || null,
          id,
          kind: result.kind ?? item?.kind ?? null,
          // Keep the local side so "dismiss" can replay it as local-wins.
          local: item
            ? {
                payload: item.payload ?? null,
                deleted: !!item.deleted,
                parentId: item.parentId ?? null,
                orderKey: item.orderKey ?? null,
              }
            : null,
          server: result.server ?? null,
          at: clock(),
        });
      }
      cfg.conflicts = uniqueConflicts(next);
    }

    const summary = queue.ack(data);
    cfg.queueSnapshot = queue.snapshot();
    if (failed.length) {
      cfg.state = SYNC_STATUS.offline;
      cfg.lastError = {
        code: 'push_failed',
        message: `${failed.length} change(s) were rejected by the server`,
        status: 0,
      };
    }
    save(workspaceId, cfg);

    return {
      ok: true,
      data: {
        applied: applied.length,
        pending: summary.pending,
        conflicts: conflicts.length,
        failed: failed.length,
      },
    };
  }

  // client.login resolves with the user object itself; tolerate a nested
  // `{ user }` payload as well so the renderer is not coupled to that detail.
  function userFrom(data) {
    if (!data || typeof data !== 'object') return null;
    if (data.user && typeof data.user === 'object') return data.user;
    if (data.id || data.email) return data;
    return null;
  }

  async function signIn({ email, password, deviceLabel } = {}) {
    const response = await call('login', { email, password, deviceLabel });
    if (!response.ok) return response;
    session = { signedIn: true, user: userFrom(response.data), checked: true };
    return { ok: true, data: { user: session.user } };
  }

  async function signUp({ name, email, password, deviceLabel } = {}) {
    const registered = await call('register', { name, email, password });
    if (!registered.ok) return registered;
    // Register does not adopt a session in the main process, so log in right
    // away: it also records the device label used for revoking devices.
    const response = await call('login', { email, password, deviceLabel });
    if (!response.ok) return response;
    session = { signedIn: true, user: userFrom(response.data), checked: true };
    return { ok: true, data: { user: session.user } };
  }

  async function signOut() {
    const response = await call('logout');
    session = { signedIn: false, user: null, checked: true };
    baselines.clear();
    if (!response.ok) return { ok: true, data: { signedIn: false, warning: response.error } };
    return { ok: true, data: { signedIn: false } };
  }

  async function refreshSession() {
    const response = await call('status');
    if (!response.ok) {
      session = { signedIn: false, user: null, checked: true };
      return response;
    }
    session = {
      signedIn: !!response.data?.signedIn,
      user: response.data?.user || null,
      checked: true,
    };
    return { ok: true, data: { ...session } };
  }

  // Synchronous status for rendering. Sync in progress lives in the persisted
  // `state` value; conflict takes precedence because it needs user attention.
  function status(workspaceId) {
    const base = {
      signedIn: session.signedIn,
      user: session.user,
      remoteId: null,
      pending: 0,
      conflicts: 0,
    };
    if (!session.signedIn) return { ...base, status: SYNC_STATUS.signedOut };

    const cfg = workspaceId != null ? cloudConfig(getWorkspace(workspaceId)) : null;
    if (!cfg) return { ...base, status: SYNC_STATUS.local };

    const conflicts = Array.isArray(cfg.conflicts) ? cfg.conflicts.length : 0;
    const pending = Array.isArray(cfg.queueSnapshot?.items) ? cfg.queueSnapshot.items.length : 0;
    let value = SYNC_STATUS.synced;
    if (conflicts) value = SYNC_STATUS.conflict;
    else if (cfg.state === SYNC_STATUS.offline) value = SYNC_STATUS.offline;
    else if (cfg.state === SYNC_STATUS.syncing) value = SYNC_STATUS.syncing;

    return {
      ...base,
      status: value,
      remoteId: cfg.remoteId,
      pending,
      conflicts,
    };
  }

  // Create the remote workspace, link it, and push every local entity as a
  // baseRev 0 create. The link and the queue are persisted before the network
  // call so a failed push is retried by the next sync instead of being lost.
  async function attachLocked(workspaceId) {
    if (!session.checked) await refreshSession();
    if (!session.signedIn) return fail('unauthorized', 'Sign in to sync a workspace.');
    const workspace = getWorkspace(workspaceId);
    if (!workspace) return fail('not_found', 'Workspace not found.');

    const existing = cloudConfig(workspace);
    if (existing) {
      // Already linked: never call the backend and never touch the durable
      // queue. Only make sure the diff baseline is hydrated for this process.
      hydrateBaseline(workspaceId, existing);
      return {
        ok: true,
        already: true,
        data: { remoteId: existing.remoteId, already: true, alreadyAttached: true },
      };
    }

    const created = await call('createWorkspace', { name: workspace.name || 'Workspace' });
    if (!created.ok) return created;
    const remoteId = created.data?.id || created.data?.workspace?.id;
    if (!remoteId) return fail('internal', 'Cloud did not return a workspace id.');

    const flat = flattenWorkspace(workspace);
    const baseline = diffEntities(
      { entities: [], byId: Object.create(null), revs: {} },
      flat,
      diffOptions()
    );

    const cfg = {
      remoteId,
      cursor: 0,
      revs: { ...baseline.revs },
      queueSnapshot: null,
      conflicts: [],
      state: SYNC_STATUS.syncing,
      lastError: null,
      attachedAt: clock(),
    };
    save(workspaceId, cfg);
    setBaseline(workspaceId, { ...flat, revs: baseline.revs, persisted: true });

    const queue = queueFor(workspaceId, cfg);
    queue.enqueue(baseline.changes);

    const pushed = await pushQueue(workspaceId, cfg, queue);
    if (!pushed.ok) {
      cfg.state = SYNC_STATUS.offline;
      cfg.lastError = pushed.error;
      save(workspaceId, cfg);
      return pushed;
    }

    const linked = getWorkspace(workspaceId);
    if (linked) {
      setBaseline(workspaceId, {
        ...flattenWorkspace(linked),
        revs: cfg.revs,
        persisted: true,
      });
    }
    cfg.state = SYNC_STATUS.synced;
    cfg.lastError = null;
    save(workspaceId, cfg);
    return {
      ok: true,
      data: {
        remoteId,
        cursor: cfg.cursor,
        pushed: pushed.data.applied,
        pending: pushed.data.pending,
      },
    };
  }

  function attach(workspaceId) {
    return lock(workspaceId, () => attachLocked(workspaceId));
  }

  async function detach(workspaceId) {
    const workspace = getWorkspace(workspaceId);
    if (!workspace) return fail('not_found', 'Workspace not found.');
    baselines.delete(workspaceId);
    patchWorkspace(workspaceId, { cloud: null });
    return { ok: true, data: { workspaceId } };
  }

  // Push pending changes, then drain the remote history into the workspace.
  // Conflict ids are skipped while pulling: the local edit is kept and the
  // server copy is stored in workspace.cloud.conflicts for the banner.
  async function syncLocked(workspaceId) {
    if (!session.checked) await refreshSession();
    if (!session.signedIn) return fail('unauthorized', 'Sign in to sync a workspace.');
    const workspace = getWorkspace(workspaceId);
    if (!workspace) return fail('not_found', 'Workspace not found.');

    const stored = cloudConfig(workspace);
    if (!stored) return fail('not_attached', 'This workspace is not linked to the cloud.');

    // Work on a copy and persist it after every step so an error cannot
    // leave half-updated revision data behind.
    const cfg = {
      ...stored,
      revs: { ...(stored.revs || {}) },
      conflicts: Array.isArray(stored.conflicts) ? [...stored.conflicts] : [],
    };
    cfg.state = SYNC_STATUS.syncing;
    cfg.lastError = null;
    save(workspaceId, cfg);

    const queue = queueFor(workspaceId, cfg);
    const localChanges = collect(workspaceId, cfg);
    if (localChanges.length) queue.enqueue(localChanges);

    const pushed = await pushQueue(workspaceId, cfg, queue);
    if (!pushed.ok) {
      cfg.state = SYNC_STATUS.offline;
      cfg.lastError = pushed.error;
      save(workspaceId, cfg);
      return {
        ...pushed,
        pending: Array.isArray(cfg.queueSnapshot?.items) ? cfg.queueSnapshot.items.length : 0,
      };
    }

    const conflictIds = new Set((cfg.conflicts || []).map((entry) => String(entry.id)));
    let cursor = Number(cfg.cursor) || 0;
    let pulled = 0;
    const pulledIds = new Set();

    for (let page = 0; page < PULL_PAGES_MAX; page += 1) {
      const before = cursor;
      const response = await call('pull', {
        workspaceId: cfg.remoteId,
        since: cursor,
        limit: PULL_LIMIT,
      });
      if (!response.ok) {
        cfg.state = SYNC_STATUS.offline;
        cfg.lastError = response.error;
        save(workspaceId, cfg);
        return {
          ok: false,
          error: response.error,
          cursor,
          pulled,
          pending: Array.isArray(cfg.queueSnapshot?.items) ? cfg.queueSnapshot.items.length : 0,
        };
      }

      const data = response.data || {};
      const changes = Array.isArray(data.changes) ? data.changes : [];
      const nextSeq = Number.isFinite(Number(data.nextSeq)) ? Number(data.nextSeq) : cursor;
      const applicable = changes.filter(
        (change) => change && change.id != null && !conflictIds.has(String(change.id))
      );
      for (const change of applicable) pulledIds.add(String(change.id));

      cursor = Math.max(cursor, nextSeq);
      cfg.cursor = cursor;
      pulled += applicable.length;

      const current = getWorkspace(workspaceId);
      if (!current) return fail('not_found', 'Workspace not found.');

      if (applicable.length) {
        const revs = { ...cfg.revs };
        const nextWorkspace = applyPulledChanges(current, applicable, revs);
        cfg.revs = revs;
        save(workspaceId, cfg, {
          collections: nextWorkspace.collections,
          environments: nextWorkspace.environments,
          globals: nextWorkspace.globals,
          activeEnvId: nextWorkspace.activeEnvId,
        });
      } else {
        save(workspaceId, cfg);
      }

      if (!data.hasMore) break;
      // A page that reports more data but does not advance the cursor would
      // spin forever, so stop and let the next sync retry.
      if (cursor <= before) break;
    }

    // Edits typed while the network calls were in flight are not queued yet.
    // Diffing against the pre-sync baseline also surfaces the pull we just
    // applied, so keep only entities the pull did not touch. Its optimistic
    // revisions must not overwrite server revisions learned from push/pull.
    const serverRevs = { ...cfg.revs };
    const serverIds = new Set([...pulledIds, ...conflictIds]);
    const lateChanges = collect(workspaceId, cfg).filter(
      (change) => !pulledIds.has(String(change.id))
    );
    for (const id of serverIds) {
      if (Object.prototype.hasOwnProperty.call(serverRevs, id)) cfg.revs[id] = serverRevs[id];
      else delete cfg.revs[id];
    }
    if (lateChanges.length) queue.enqueue(lateChanges);

    const linked = getWorkspace(workspaceId);
    if (linked) {
      setBaseline(workspaceId, {
        ...flattenWorkspace(linked),
        revs: cfg.revs,
        persisted: true,
      });
    }
    cfg.state = SYNC_STATUS.synced;
    cfg.lastError = null;
    save(workspaceId, cfg);

    return {
      ok: true,
      data: {
        pushed: pushed.data.applied,
        pulled,
        cursor: cfg.cursor,
        conflicts: (cfg.conflicts || []).length,
        pending: Array.isArray(cfg.queueSnapshot?.items) ? cfg.queueSnapshot.items.length : 0,
      },
    };
  }

  function sync(workspaceId) {
    return lock(workspaceId, () => syncLocked(workspaceId));
  }

  // Queue local edits so an edit made between syncs survives a push failure.
  function enqueue(workspaceId) {
    const workspace = getWorkspace(workspaceId);
    const cfg = cloudConfig(workspace);
    if (!cfg) return fail('not_attached', 'This workspace is not linked to the cloud.');
    if (syncing.has(workspaceId)) {
      // A running sync will collect these edits itself before it finishes.
      return { ok: true, data: { queued: 0, deferred: true } };
    }
    const changes = collect(workspaceId, cfg);
    if (!changes.length) return { ok: true, data: { queued: 0 } };
    queueFor(workspaceId, cfg).enqueue(changes);
    return { ok: true, data: { queued: changes.length } };
  }

  // Called when a workspace is opened: diff the current data against the
  // persisted baseline and queue whatever changed while the app was closed.
  // Idempotent: capturing advances the baseline, so a second call (duplicate
  // mount, StrictMode) enqueues nothing. Without a known baseline nothing is
  // queued: a fresh link must not turn the whole workspace into edits.
  function captureOfflineEdits(workspaceId) {
    const workspace = getWorkspace(workspaceId);
    const cfg = cloudConfig(workspace);
    if (!cfg) return fail('not_attached', 'This workspace is not linked to the cloud.');
    if (syncing.has(workspaceId)) {
      // A running sync collects these edits itself before it finishes.
      return { ok: true, data: { queued: 0, deferred: true } };
    }

    const stored = cfg.baseline;
    if (!stored || !Array.isArray(stored.entities)) {
      // No server state to diff against yet. Seed the baseline from the
      // current workspace so later edits are detected, but enqueue nothing.
      hydrateBaseline(workspaceId, cfg);
      return { ok: true, data: { queued: 0, captured: 0, skipped: true } };
    }

    const changes = collect(workspaceId, cfg);
    if (!changes.length) return { ok: true, data: { queued: 0, captured: 0 } };
    queueFor(workspaceId, cfg).enqueue(changes);
    return { ok: true, data: { queued: changes.length, captured: changes.length } };
  }

  // Resolve stored conflicts in either direction. No network call happens
  // here: the decision and its effects are persisted first, so a later failed
  // or offline push can never silently drop a conflict.
  //
  //   'local'  keep the local edit: rebase it on the server revision and
  //            requeue it as an update (the old "dismiss" behaviour).
  //   'server' apply the stored server copy locally and advance its revision.
  function resolveConflicts(workspaceId, ids, choice = 'local') {
    const workspace = getWorkspace(workspaceId);
    const cfg = cloudConfig(workspace);
    if (!cfg) return fail('not_attached', 'This workspace is not linked to the cloud.');

    const mode = choice === 'server' ? 'server' : 'local';
    const all = Array.isArray(cfg.conflicts) ? cfg.conflicts : [];
    const wanted =
      ids == null
        ? null
        : new Set(
            (Array.isArray(ids) ? ids : [ids])
              .filter((value) => value != null)
              .map((value) => String(value))
          );
    const selected = all.filter(
      (conflict) =>
        conflict &&
        conflict.id != null &&
        (!wanted || wanted.has(String(conflict.id)))
    );
    const actionable =
      mode === 'local'
        ? selected
        : selected.filter((conflict) => conflict.server && typeof conflict.server === 'object');
    if (!actionable.length) return { ok: true, data: { resolved: 0, requeued: 0, mode } };

    cfg.revs = { ...(cfg.revs || {}) };

    if (mode === 'local') {
      // Replaying with `baseRev = server.rev` turns the stale write into an
      // update of the current server entity instead of a second conflict.
      const replay = [];
      for (const conflict of actionable) {
        const local = conflict.local;
        const baseRev = Number(conflict.server?.rev ?? cfg.revs[conflict.id] ?? 0);
        cfg.revs[conflict.id] = baseRev;
        if (!local) continue;
        replay.push({
          id: conflict.id,
          kind: conflict.kind,
          baseRev,
          payload: local.deleted ? null : local.payload,
          parentId: local.deleted ? null : local.parentId ?? null,
          orderKey: local.deleted ? null : local.orderKey ?? null,
          deleted: !!local.deleted,
        });
      }
      const base = baselines.get(workspaceId) || hydrateBaseline(workspaceId, cfg);
      if (base) {
        setBaseline(workspaceId, {
          entities: base.entities,
          byId: base.byId,
          revs: cfg.revs,
          persisted: base.persisted,
        });
      }
      cfg.conflicts = all.filter((conflict) => !actionable.includes(conflict));
      save(workspaceId, cfg);
      if (replay.length) queueFor(workspaceId, cfg).enqueue(replay);
      return { ok: true, data: { resolved: actionable.length, requeued: replay.length, mode } };
    }

    // "Keep server": paint the server copy over the local entity, then
    // rebaseline so the applied copy is not diffed back out as a local edit.
    const flat = flattenWorkspace(workspace);
    const changes = [];
    const resolved = [];
    for (const conflict of actionable) {
      const server = conflict.server;
      const local = conflict.local;
      const existing = flat.byId[conflict.id] || null;
      const kind = conflict.kind || existing?.kind || null;
      if (server.payload == null) {
        // The server deleted (or never stored) this entity.
        changes.push({ id: conflict.id, kind, deleted: true });
        resolved.push(conflict);
        continue;
      }
      if (!kind) continue; // Cannot place the payload; keep the conflict.
      const rev = Number(server.rev);
      changes.push({
        id: conflict.id,
        kind,
        payload: server.payload,
        parentId: existing?.parentId ?? local?.parentId ?? null,
        orderKey: existing?.orderKey ?? local?.orderKey ?? null,
        deleted: false,
        rev: Number.isFinite(rev) ? rev : undefined,
      });
      resolved.push(conflict);
    }

    if (resolved.length) {
      const nextWorkspace = applyPulledChanges(workspace, changes, cfg.revs);
      setBaseline(workspaceId, {
        ...flattenWorkspace(nextWorkspace),
        revs: cfg.revs,
        persisted: true,
      });
      cfg.conflicts = all.filter((conflict) => !resolved.includes(conflict));
      save(workspaceId, cfg, {
        collections: nextWorkspace.collections,
        environments: nextWorkspace.environments,
        globals: nextWorkspace.globals,
        activeEnvId: nextWorkspace.activeEnvId,
      });
    }

    return { ok: true, data: { resolved: resolved.length, requeued: 0, mode } };
  }

  // Backwards-compatible alias: resolving a conflict by keeping the local side
  // is what the conflict banner's dismiss button has always done.
  function dismissConflicts(workspaceId, ids = null) {
    return resolveConflicts(workspaceId, ids, 'local');
  }

  return {
    signIn,
    signUp,
    signOut,
    refreshSession,
    status,
    attach,
    detach,
    sync,
    enqueue,
    captureOfflineEdits,
    resolveConflicts,
    dismissConflicts,
    nextSyncDelay: (attempt) => nextBackoff(attempt),
  };
}
