import os from 'node:os';

// Workspace-key provisioning and secret envelope helpers (Phase 4.1).
//
// The workspace key is generated in the main process, wrapped once per active
// member device with X25519, and only ever stored wrapped on the server. This
// manager:
//   1. registers this device's public key (once per process),
//   2. fetches this caller's wrapped keys and unwraps the newest usable one,
//   3. bootstraps (or rotates forward) a workspace key when the caller is an
//      owner/admin and no key is available for this device yet.
//
// It never returns key material to the renderer: `encrypt`/`decrypt` are the
// only value-level operations, and both keep the workspace key in-process.

/** Stable reason codes surfaced through IPC (see electron/cloud/ipc.js). */
export const WORKSPACE_KEY_REASONS = Object.freeze({
  WAITING: 'waiting_key',
  NOT_MEMBER: 'not_member',
  WORKSPACE_NOT_FOUND: 'workspace_not_found',
  NO_DEVICE_KEYS: 'no_device_keys',
  UNAVAILABLE: 'unavailable',
});

const BOOTSTRAP_ROLES = new Set(['owner', 'admin']);

/** Typed failure with a stable `code`; messages never contain key material. */
export class WorkspaceKeyError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message);
    this.name = 'WorkspaceKeyError';
    this.code = typeof code === 'string' && code ? code : 'workspace_key_error';
    if (cause !== undefined) this.cause = cause;
  }
}

function requireWorkspaceId(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('workspaceId is required');
  }
  return value;
}

/**
 * Values/envelopes arrive either as a `{ name: value }` object or as an array
 * (the renderer batches secret rows positionally).
 */
function requireCollection(value, field) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return value;
  throw new TypeError(`${field} must be an object or an array`);
}

function isPositiveVersion(value) {
  const version = Number(value);
  return Number.isFinite(version) && version > 0;
}

/** Short, human-readable label: platform plus the first hostname segment. */
export function deviceKeyLabel() {
  let host = '';
  try {
    host = os.hostname();
  } catch {
    host = '';
  }
  const platform = process.platform || 'unknown';
  const short = (host.split('.')[0] || 'device').slice(0, 32);
  return `${platform}-${short}`;
}

function roleOf(workspace) {
  if (!workspace || typeof workspace !== 'object') return null;
  const role = workspace.role ?? workspace.workspace?.role ?? workspace.member?.role;
  return typeof role === 'string' && role ? role : null;
}

/** Map "you cannot see this workspace" failures to a stable reason. */
function membershipReason(err) {
  if (!err || typeof err !== 'object') return null;
  const status = Number(err.status) || 0;
  if (status === 404) return WORKSPACE_KEY_REASONS.WORKSPACE_NOT_FOUND;
  if (status === 403) return WORKSPACE_KEY_REASONS.NOT_MEMBER;
  if (err.code === 'not_member') return WORKSPACE_KEY_REASONS.NOT_MEMBER;
  return null;
}

function keyEntries(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.keys)) return data.keys;
  return [];
}

function deviceKeyEntries(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.deviceKeys)) return data.deviceKeys;
  return [];
}

/**
 * Unwrap the newest key-set version from the caller's wrapped keys. Only the
 * highest version is considered: falling back to an older version after a
 * rotation would encrypt new secrets under a key the rest of the workspace has
 * already moved past. Entries at that version are wrapped per active device of
 * the caller, so each one is tried until the private key opens its own.
 */
function unwrapNewest(entries, privateKey, crypto) {
  const candidates = keyEntries(entries)
    .filter(
      (entry) =>
        entry &&
        typeof entry.wrappedKey === 'string' &&
        entry.wrappedKey.length > 0 &&
        isPositiveVersion(entry.version)
    )
    .map((entry) => ({ version: Number(entry.version), wrappedKey: entry.wrappedKey }));
  if (candidates.length === 0) return null;

  const highest = candidates.reduce(
    (max, candidate) => (candidate.version > max ? candidate.version : max),
    0
  );
  for (const candidate of candidates) {
    if (candidate.version !== highest) continue;
    try {
      const key = crypto.unwrapWorkspaceKey({
        wrappedKey: candidate.wrappedKey,
        privateKey,
      });
      if (key) return { ready: true, version: highest, key };
    } catch {
      /* wrapped for another of the caller's devices: try the next entry */
    }
  }
  return null;
}

function nextVersion(entries) {
  let highest = 0;
  for (const entry of keyEntries(entries)) {
    const version = Number(entry?.version);
    if (isPositiveVersion(version) && version > highest) highest = Math.floor(version);
  }
  return highest + 1;
}

function readyState(state) {
  return { ready: true, version: state.version, key: state.key };
}

function waitingState(reason) {
  return { ready: false, version: null, reason };
}

/**
 * @param {{
 *   client: object,
 *   deviceKeys: { loadOrCreate: Function },
 *   crypto: object,
 * }} deps
 */
export function createWorkspaceKeyManager({ client, deviceKeys, crypto } = {}) {
  if (!client || typeof client !== 'object') {
    throw new TypeError('createWorkspaceKeyManager requires a cloud client');
  }
  for (const method of [
    'registerDeviceKey',
    'workspaceKeys',
    'workspace',
    'workspaceDeviceKeys',
    'putWorkspaceKeys',
  ]) {
    if (typeof client[method] !== 'function') {
      throw new TypeError(`createWorkspaceKeyManager requires client.${method}()`);
    }
  }
  if (!deviceKeys || typeof deviceKeys.loadOrCreate !== 'function') {
    throw new TypeError('createWorkspaceKeyManager requires a device key manager');
  }
  for (const method of [
    'generateWorkspaceKey',
    'wrapWorkspaceKey',
    'unwrapWorkspaceKey',
    'encryptSecretValue',
    'decryptSecretValue',
  ]) {
    if (!crypto || typeof crypto[method] !== 'function') {
      throw new TypeError(`createWorkspaceKeyManager requires crypto.${method}()`);
    }
  }

  // Only fully usable keys are cached; a "waiting" answer is always re-checked
  // so the first successful admin wrap is picked up without a restart.
  const cache = new Map();
  const inFlight = new Map();
  const shareCache = new Map();
  const shareCheckedAt = new Map();
  let registration = null;

  function registerOnce() {
    if (registration) return registration;
    registration = (async () => {
      const pair = await deviceKeys.loadOrCreate();
      await client.registerDeviceKey({
        publicKey: pair.publicKey,
        label: deviceKeyLabel(),
      });
      return pair;
    })().catch((err) => {
      // Allow a later call to retry after a transient failure.
      registration = null;
      throw err;
    });
    return registration;
  }

  async function bootstrap(id, pair, entries) {
    const workspace = await client.workspace(id);
    const role = roleOf(workspace);
    if (!role || !BOOTSTRAP_ROLES.has(role)) {
      return waitingState(WORKSPACE_KEY_REASONS.WAITING);
    }

    const recipients = deviceKeyEntries(await client.workspaceDeviceKeys(id));
    const version = nextVersion(entries);
    const workspaceKey = crypto.generateWorkspaceKey();
    const seen = new Set();
    const wrapped = [];

    for (const recipient of recipients) {
      if (!recipient || typeof recipient.publicKey !== 'string' || !recipient.publicKey) {
        continue;
      }
      const deviceKeyId = recipient.id ?? recipient.deviceKeyId;
      if (typeof deviceKeyId !== 'string' || !deviceKeyId || seen.has(deviceKeyId)) {
        continue;
      }
      seen.add(deviceKeyId);
      wrapped.push({
        deviceKeyId,
        wrappedKey: crypto.wrapWorkspaceKey({
          workspaceKey,
          recipientPublicKey: recipient.publicKey,
        }),
      });
    }

    if (wrapped.length === 0) {
      return waitingState(WORKSPACE_KEY_REASONS.NO_DEVICE_KEYS);
    }

    let created;
    try {
      created = await client.putWorkspaceKeys(id, { version, entries: wrapped });
    } catch (err) {
      // Another admin created the key set first: adopt it instead of failing.
      if (Number(err?.status) === 409) {
        const adopted = unwrapNewest(await client.workspaceKeys(id), pair.privateKey, crypto);
        if (adopted) {
          cache.set(id, adopted);
          return readyState(adopted);
        }
      }
      throw err;
    }

    const createdVersion = Number(created?.version);
    const state = {
      ready: true,
      version: isPositiveVersion(createdVersion) ? Math.floor(createdVersion) : version,
      key: workspaceKey,
    };
    cache.set(id, state);
    // Bootstrap already wrapped every active device; avoid a duplicate PUT.
    shareCheckedAt.set(id, Date.now());
    return readyState(state);
  }


  function hasVersionEntries(entries) {
    return Array.isArray(entries) && entries.some((entry) => isPositiveVersion(Number(entry?.version)));
  }

  // Wrap the workspace key for every active member device that lacks an entry
  // at the current version. Upserting the same entries is idempotent.
  async function shareWithDevices(id, state) {
    const workspace = await client.workspace(id);
    if (!BOOTSTRAP_ROLES.has(roleOf(workspace))) return;

    const recipients = deviceKeyEntries(await client.workspaceDeviceKeys(id));
    const usable = recipients.filter(
      (recipient) => recipient && typeof recipient.publicKey === 'string' && recipient.publicKey
    );
    const signature = `${state.version}:${usable
      .map((recipient) => recipient.id ?? recipient.deviceKeyId)
      .filter(Boolean)
      .sort()
      .join(',')}`;
    if (shareCache.get(id) === signature) return;

    const seen = new Set();
    const entries = [];
    for (const recipient of usable) {
      const deviceKeyId = recipient.id ?? recipient.deviceKeyId;
      if (typeof deviceKeyId !== 'string' || !deviceKeyId || seen.has(deviceKeyId)) continue;
      seen.add(deviceKeyId);
      entries.push({
        deviceKeyId,
        wrappedKey: crypto.wrapWorkspaceKey({
          workspaceKey: state.key,
          recipientPublicKey: recipient.publicKey,
        }),
      });
    }
    if (entries.length === 0) return;

    await client.putWorkspaceKeys(id, { version: state.version, entries });
    shareCache.set(id, signature);
    shareCheckedAt.set(id, Date.now());
  }

  const SHARE_RECHECK_MS = 15000;
  async function maybeShare(id, state) {
    const last = shareCheckedAt.get(id) || 0;
    if (Date.now() - last < SHARE_RECHECK_MS) return;
    shareCheckedAt.set(id, Date.now());
    await shareWithDevices(id, state);
  }

  async function resolve(id, pair) {
    let entries;
    try {
      entries = await client.workspaceKeys(id);
    } catch (err) {
      const reason = membershipReason(err);
      if (reason) return waitingState(reason);
      throw err;
    }

    const adopted = unwrapNewest(entries, pair.privateKey, crypto);
    if (adopted) {
      cache.set(id, adopted);
      await shareWithDevices(id, adopted).catch(() => {});
      return readyState(adopted);
    }

    // A key set already exists but none of its entries is mine. Creating a
    // new version here would orphan ciphertexts encrypted under the existing
    // key, so an existing member device must share it instead.
    if (hasVersionEntries(entries)) {
      return waitingState(WORKSPACE_KEY_REASONS.WAITING);
    }

    try {
      return await bootstrap(id, pair, entries);
    } catch (err) {
      const reason = membershipReason(err);
      if (reason) return waitingState(reason);
      throw err;
    }
  }

  /**
   * Resolve the workspace key for this device, provisioning it when allowed.
   * Returns `{ ready: true, version, key }` or `{ ready: false, version: null,
   * reason }`; only transport/auth failures reject.
   */
  async function ensure(workspaceId) {
    const id = requireWorkspaceId(workspaceId);
    const cached = cache.get(id);
    if (cached) {
      await maybeShare(id, cached).catch(() => {});
      return readyState(cached);
    }

    const pending = inFlight.get(id);
    if (pending) return pending;

    const run = (async () => {
      const pair = await registerOnce();
      return resolve(id, pair);
    })().finally(() => {
      inFlight.delete(id);
    });

    inFlight.set(id, run);
    return run;
  }

  function requireReady(state) {
    if (state.ready) return state;
    throw new WorkspaceKeyError(
      state.reason || WORKSPACE_KEY_REASONS.WAITING,
      'Workspace key is not available on this device yet'
    );
  }

  /**
   * Encrypt plaintext values. Accepts `{ name: plaintext }` (returns the same
   * shape) or an array (returns an array of the same length, with `null` for
   * absent entries so positional callers stay aligned).
   */
  async function encrypt(workspaceId, values) {
    const input = requireCollection(values, 'values');
    const state = requireReady(await ensure(workspaceId));

    if (Array.isArray(input)) {
      return input.map((plaintext, index) => {
        if (plaintext === null || plaintext === undefined) return null;
        if (typeof plaintext !== 'string') {
          throw new TypeError(`values[${index}] must be a string`);
        }
        return crypto.encryptSecretValue(state.key, plaintext);
      });
    }

    const envelopes = {};
    for (const [name, plaintext] of Object.entries(input)) {
      if (plaintext === null || plaintext === undefined) continue;
      if (typeof plaintext !== 'string') {
        throw new TypeError(`values.${name} must be a string`);
      }
      envelopes[name] = crypto.encryptSecretValue(state.key, plaintext);
    }
    return envelopes;
  }

  /**
   * Decrypt envelopes. Accepts the same object/array shapes as {@link encrypt}.
   * A missing or undecryptable entry yields `null` for that entry only; the
   * rest of the batch is still returned.
   */
  async function decrypt(workspaceId, envelopes) {
    const input = requireCollection(envelopes, 'envelopes');
    const state = requireReady(await ensure(workspaceId));

    const open = (envelope) => {
      if (typeof envelope !== 'string' || !envelope) return null;
      try {
        return crypto.decryptSecretValue(state.key, envelope);
      } catch {
        return null;
      }
    };

    if (Array.isArray(input)) return input.map(open);

    const values = {};
    for (const [name, envelope] of Object.entries(input)) {
      values[name] = open(envelope);
    }
    return values;
  }

  /** Drop cached key material, for one workspace or (no argument) all. */
  function reset(workspaceId) {
    if (workspaceId === undefined) {
      cache.clear();
      return;
    }
    cache.delete(requireWorkspaceId(workspaceId));
  }

  return { ensure, encrypt, decrypt, reset };
}
