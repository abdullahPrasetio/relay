import os from 'node:os';

// Main-process client for relay-api.
//
// The renderer never talks to the backend: it goes through preload -> IPC ->
// this client. Credentials stay in main. The access token lives in memory
// only; the refresh token is handed to the injected `tokenStore`, which
// persists it encrypted (see ./token-store.js).
//
// Error contract: every failure is a CloudError whose `code` is one of
//   - 'offline'      network failure, abort, or timeout (never clears tokens)
//   - 'unauthorized' 401 (after one refresh attempt)
//   - 'http'         any other non-2xx response; carries `status` + envelope
// Messages never include access or refresh tokens.

const DEFAULT_BASE_URL = 'http://127.0.0.1:8080';
const DEFAULT_TIMEOUT_MS = 15000;
const API_PREFIX = '/api/v1';

export class CloudError extends Error {
  constructor(code, message, { status = 0, envelope = null, cause } = {}) {
    super(message);
    this.name = 'CloudError';
    this.code = code;
    this.status = status;
    this.envelope = envelope;
    if (cause !== undefined) this.cause = cause;
  }
}

/** Accept either a bare origin or one that already ends in /api/vN. */
function normalizeBaseUrl(raw) {
  const trimmed = String(raw || DEFAULT_BASE_URL).replace(/\/+$/, '') || DEFAULT_BASE_URL;
  return /\/api\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}${API_PREFIX}`;
}

function defaultDeviceLabel() {
  try {
    return `Relay (${os.hostname()})`;
  } catch {
    return 'Relay desktop';
  }
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${field} is required`);
  }
  return value;
}

function requireId(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('id is required');
  }
  return encodeURIComponent(value);
}

const COMMENT_MAX_LENGTH = 4000;

/** Validated comment text: trimmed, 1..COMMENT_MAX_LENGTH characters. */
function commentBody(value) {
  const body = requiredString(value, 'body').trim();
  if (body.length > COMMENT_MAX_LENGTH) {
    throw new TypeError(`body must be at most ${COMMENT_MAX_LENGTH} characters`);
  }
  return body;
}

/**
 * Optional mention list: user id strings in input order, deduplicated. The
 * server still checks that every id is a current workspace member; invalid
 * ids are rejected there with 422. An explicitly empty array clears the set
 * on PATCH.
 */
function mentionIds(value) {
  if (!Array.isArray(value)) {
    throw new TypeError('mentions must be an array of user ids');
  }
  const seen = new Set();
  const ids = [];
  for (const entry of value) {
    const id = requiredString(entry, 'mention id').trim();
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

const WORKSPACE_ROLES = ['owner', 'admin', 'editor', 'viewer'];

function requireRole(value) {
  const role = requiredString(value, 'role');
  if (!WORKSPACE_ROLES.includes(role)) {
    throw new TypeError(`role must be one of ${WORKSPACE_ROLES.join(', ')}`);
  }
  return role;
}

function requirePositiveInt(value, field, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new TypeError(`${field} must be a positive number`);
  }
  return Math.floor(number);
}

/** Workspace key versions are whole numbers starting at 1. */
function requireVersion(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new TypeError('version must be a positive integer');
  }
  return number;
}

/** Entries are `{ deviceKeyId, wrappedKey }` pairs, one per recipient device. */
function requireKeyEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TypeError('entries must be a non-empty array');
  }
  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('each entry must be an object');
    }
    return {
      deviceKeyId: requiredString(entry.deviceKeyId, 'deviceKeyId'),
      wrappedKey: requiredString(entry.wrappedKey, 'wrappedKey'),
    };
  });
}

/**
 * Build a monitor create/patch body. Creates require the three schedule
 * fields; patches only carry the fields the caller supplied, so an enabled
 * toggle never overwrites the rest of the monitor.
 */
function monitorPayload(payload, { partial = false } = {}) {
  if (!payload || typeof payload !== 'object') {
    throw new TypeError('payload must be an object');
  }
  const body = {};
  for (const field of ['name', 'requestId', 'cron']) {
    if (payload[field] !== undefined) {
      body[field] = requiredString(payload[field], field);
    } else if (!partial) {
      body[field] = requiredString(payload[field], field);
    }
  }
  if (payload.enabled !== undefined) {
    if (typeof payload.enabled !== 'boolean') {
      throw new TypeError('enabled must be a boolean');
    }
    body.enabled = payload.enabled;
  }
  if (payload.alertWebhook !== undefined) {
    if (payload.alertWebhook === null) {
      body.alertWebhook = null;
    } else if (typeof payload.alertWebhook !== 'string') {
      throw new TypeError('alertWebhook must be a string');
    } else {
      body.alertWebhook = payload.alertWebhook.trim() || null;
    }
  }
  return body;
}

export function createCloudClient({
  baseUrl = process.env.RELAY_API_URL || DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  tokenStore,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createCloudClient requires a fetch implementation');
  }
  if (!tokenStore || typeof tokenStore.get !== 'function' || typeof tokenStore.set !== 'function') {
    throw new TypeError('createCloudClient requires a tokenStore with get/set/clear');
  }

  const root = normalizeBaseUrl(baseUrl);
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  // Memory-only session state.
  let accessToken = null;
  let refreshToken = null; // mirror of the persisted token, avoids reads
  let user = null;
  let deviceLabel = null;
  let refreshInFlight = null;

  async function storedRefreshToken() {
    try {
      return (await tokenStore.get()) || null;
    } catch {
      return null;
    }
  }

  async function storedDeviceLabel() {
    try {
      return (await tokenStore.getDeviceLabel?.()) || null;
    } catch {
      return null;
    }
  }

  async function clearLocalSession() {
    accessToken = null;
    refreshToken = null;
    user = null;
    try {
      await tokenStore.clear?.();
    } catch {
      /* the in-memory session is gone either way */
    }
  }

  /** One HTTP exchange. `token` is the exact access token to send. */
  async function send(path, { method = 'GET', body, token = null } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;

    try {
      let response;
      try {
        response = await fetchImpl(`${root}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        // fetch rejects on DNS failure, refused connections, aborts/timeouts.
        throw new CloudError('offline', 'Cannot reach Relay Cloud', { cause: err });
      }

      if (response.status === 204) return null;

      let text = '';
      try {
        text = await response.text();
      } catch (err) {
        throw new CloudError('offline', 'Connection lost while reading the response', {
          cause: err,
        });
      }

      let envelope = null;
      if (text) {
        try {
          envelope = JSON.parse(text);
        } catch {
          if (response.ok) {
            throw new CloudError('http', 'Relay Cloud returned an invalid response', {
              status: response.status,
            });
          }
        }
      }

      if (!response.ok) {
        const code = response.status === 401 ? 'unauthorized' : 'http';
        const message =
          typeof envelope?.message === 'string' && envelope.message.trim()
            ? envelope.message
            : `Relay Cloud request failed (${response.status})`;
        throw new CloudError(code, message, { status: response.status, envelope });
      }

      if (envelope && envelope.status === false) {
        throw new CloudError('http', envelope.message || 'Relay Cloud request failed', {
          status: response.status,
          envelope,
        });
      }

      return envelope?.data ?? null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Single-flight refresh. Concurrent 401s share one refresh request; the
   * retried requests then reuse the new access token.
   */
  function refresh() {
    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = (async () => {
      const token = refreshToken || (await storedRefreshToken());
      if (!token) throw new CloudError('unauthorized', 'Not signed in');

      const label = deviceLabel || (await storedDeviceLabel()) || defaultDeviceLabel();
      let data;
      try {
        data = await send('/auth/refresh', {
          method: 'POST',
          body: { refreshToken: token, deviceLabel: label },
        });
      } catch (err) {
        // A rejected refresh means the session is dead; a network failure
        // does not, so tokens are only dropped for the former.
        if (err instanceof CloudError && err.code === 'unauthorized') {
          await clearLocalSession();
        }
        throw err;
      }

      if (!data?.accessToken || !data?.refreshToken) {
        throw new CloudError('http', 'Relay Cloud returned an incomplete session', { status: 200 });
      }

      await adoptSession(data, label);
      return data;
    })().finally(() => {
      refreshInFlight = null;
    });

    return refreshInFlight;
  }

  async function adoptSession(data, label) {
    if (!data?.accessToken || !data?.refreshToken) {
      throw new CloudError('http', 'Relay Cloud returned an incomplete session', { status: 200 });
    }
    accessToken = data.accessToken;
    refreshToken = data.refreshToken;
    if (data.user) user = data.user;
    if (label) deviceLabel = label;
    try {
      await tokenStore.set(data.refreshToken, { deviceLabel: deviceLabel || '' });
    } catch (err) {
      await clearLocalSession();
      throw new CloudError('http', 'Could not store the session securely', { cause: err });
    }
  }

  /** Authenticated call: on 401 refresh once (single-flight) and retry once. */
  async function call(path, options = {}) {
    const auth = options.auth !== false;
    const tokenUsed = auth ? accessToken : null;

    try {
      return await send(path, { ...options, token: tokenUsed });
    } catch (err) {
      if (!(err instanceof CloudError) || err.code !== 'unauthorized' || !auth) throw err;

      // Another caller already rotated the token while this request was in
      // flight: retry with the new one instead of refreshing again.
      if (!accessToken || accessToken === tokenUsed) await refresh();

      try {
        return await send(path, { ...options, token: accessToken });
      } catch (retryErr) {
        if (retryErr instanceof CloudError && retryErr.code === 'unauthorized') {
          await clearLocalSession();
        }
        throw retryErr;
      }
    }
  }

  return {
    get baseUrl() {
      return root;
    },

    /**
     * Main-process only (never bridged over IPC): the change stream reads the
     * current access token for each reconnect. It may be null until the next
     * authenticated call refreshes the session.
     */
    currentAccessToken() {
      return accessToken;
    },

    /**
     * Main-process only: token provider for long-lived consumers such as the
     * SSE change stream. After a restart only the refresh token survives, so
     * this performs the single-flight refresh instead of returning null.
     */
    async ensureAccessToken() {
      if (accessToken) return accessToken;
      const data = await refresh();
      return data?.accessToken || null;
    },

    async register({ name, email, password } = {}) {
      const data = await call('/auth/register', {
        method: 'POST',
        auth: false,
        body: {
          name: requiredString(name, 'name'),
          email: requiredString(email, 'email'),
          password: requiredString(password, 'password'),
        },
      });
      return data;
    },

    async login({ email, password, deviceLabel: label } = {}) {
      const chosenLabel = (typeof label === 'string' && label.trim()) || defaultDeviceLabel();
      const data = await call('/auth/login', {
        method: 'POST',
        auth: false,
        body: {
          email: requiredString(email, 'email'),
          password: requiredString(password, 'password'),
          deviceLabel: chosenLabel,
        },
      });
      await adoptSession(data, chosenLabel);
      return user;
    },

    /**
     * Explicit sign-out. The local session is always cleared, even when the
     * server cannot be reached: only a network failure inside ordinary
     * requests leaves credentials untouched.
     */
    async logout() {
      const token = refreshToken || (await storedRefreshToken());
      if (token) {
        try {
          await send('/auth/logout', { method: 'POST', body: { refreshToken: token } });
        } catch {
          /* best effort; local sign-out proceeds regardless */
        }
      }
      await clearLocalSession();
      return null;
    },

    async devices() {
      return call('/auth/devices');
    },

    async revokeDevice(id) {
      await call(`/auth/devices/${requireId(id)}`, { method: 'DELETE' });
      return null;
    },

    // --- Device key registry (end-to-end secret sharing) -------------------
    // Public keys only: the private key never leaves the main process.

    async registerDeviceKey({ publicKey, label } = {}) {
      const body = { publicKey: requiredString(publicKey, 'publicKey') };
      if (typeof label === 'string' && label.trim()) body.label = label.trim();
      const data = await call('/devices/keys', { method: 'PUT', body });
      return data ?? null;
    },

    async listDeviceKeys() {
      const data = await call('/devices/keys');
      return Array.isArray(data) ? data : Array.isArray(data?.keys) ? data.keys : [];
    },

    async revokeDeviceKey(id) {
      await call(`/devices/keys/${requireId(id)}`, { method: 'DELETE' });
      return null;
    },

    async me() {
      const data = await call('/auth/me');
      if (data) user = data;
      return data;
    },

    async listWorkspaces() {
      return call('/workspaces');
    },

    async createWorkspace(nameOrPayload) {
      const name =
        typeof nameOrPayload === 'string' ? nameOrPayload : nameOrPayload?.name;
      const data = await call('/workspaces', {
        method: 'POST',
        body: { name: requiredString(name, 'name') },
      });
      return data;
    },

    async renameWorkspace(idOrPayload, maybeName) {
      const { id, name } =
        typeof idOrPayload === 'object' && idOrPayload !== null
          ? { id: idOrPayload.id, name: idOrPayload.name }
          : { id: idOrPayload, name: maybeName };
      const data = await call(`/workspaces/${requireId(id)}`, {
        method: 'PATCH',
        body: { name: requiredString(name, 'name') },
      });
      return data;
    },

    async deleteWorkspace(idOrPayload) {
      const id = typeof idOrPayload === 'object' ? idOrPayload?.id : idOrPayload;
      await call(`/workspaces/${requireId(id)}`, { method: 'DELETE' });
      return null;
    },

    /** Single workspace including this caller's role. */
    async workspace(workspaceId) {
      const data = await call(`/workspaces/${requireId(workspaceId)}`);
      return data ?? null;
    },

    // --- Workspace key provisioning ---------------------------------------

    async workspaceDeviceKeys(workspaceId) {
      const data = await call(`/workspaces/${requireId(workspaceId)}/device-keys`);
      return Array.isArray(data) ? data : Array.isArray(data?.deviceKeys) ? data.deviceKeys : [];
    },

    /** Wrapped workspace keys addressed to this caller's active devices. */
    async workspaceKeys(workspaceId) {
      const data = await call(`/workspaces/${requireId(workspaceId)}/keys`);
      return Array.isArray(data) ? data : Array.isArray(data?.keys) ? data.keys : [];
    },

    async putWorkspaceKeys(workspaceId, { version, entries } = {}) {
      const data = await call(`/workspaces/${requireId(workspaceId)}/keys`, {
        method: 'POST',
        body: { version: requireVersion(version), entries: requireKeyEntries(entries) },
      });
      return data ?? null;
    },

    async rotateWorkspaceKeys(workspaceId) {
      const data = await call(`/workspaces/${requireId(workspaceId)}/keys/rotate`, {
        method: 'POST',
      });
      return data ?? null;
    },

    async pushChanges(workspaceId, changes) {
      if (!Array.isArray(changes)) throw new TypeError('changes must be an array');
      const data = await call(`/workspaces/${requireId(workspaceId)}/changes`, {
        method: 'POST',
        body: { changes },
      });
      return data;
    },

    async pullChanges(workspaceId, { since = 0, limit = 500 } = {}) {
      const params = new URLSearchParams();
      params.set('since', String(since ?? 0));
      params.set('limit', String(limit ?? 500));
      const data = await call(`/workspaces/${requireId(workspaceId)}/changes?${params}`);
      return data;
    },

    /** Workspace members, including display `name` and `email` for mentions. */
    async members(workspaceId) {
      const data = await call(`/workspaces/${requireId(workspaceId)}/members`);
      if (Array.isArray(data)) return data;
      return Array.isArray(data?.members) ? data.members : [];
    },

    async updateMemberRole(workspaceId, userId, role) {
      const data = await call(
        `/workspaces/${requireId(workspaceId)}/members/${requireId(userId)}`,
        { method: 'PATCH', body: { role: requireRole(role) } }
      );
      return data ?? null;
    },

    async removeMember(workspaceId, userId) {
      await call(`/workspaces/${requireId(workspaceId)}/members/${requireId(userId)}`, {
        method: 'DELETE',
      });
      return null;
    },

    async presence(workspaceId, entityId = null) {
      const data = await call(`/workspaces/${requireId(workspaceId)}/presence`, {
        method: 'POST',
        body: { entityId: entityId || null },
      });
      return data ?? null;
    },

    async createInvite(workspaceId, { role, expiresInHours } = {}) {
      const data = await call(`/workspaces/${requireId(workspaceId)}/invites`, {
        method: 'POST',
        body: {
          role: requireRole(role),
          expiresInHours: requirePositiveInt(expiresInHours, 'expiresInHours', 72),
        },
      });
      return data ?? null;
    },

    async listAudit(workspaceId, { before, limit } = {}) {
      const params = new URLSearchParams();
      params.set('limit', String(requirePositiveInt(limit, 'limit', 50)));
      if (before !== undefined && before !== null && before !== '') {
        params.set('before', String(before));
      }
      const data = await call(`/workspaces/${requireId(workspaceId)}/audit?${params}`);
      return {
        events: Array.isArray(data?.events) ? data.events : [],
        nextBefore: data?.nextBefore ?? null,
      };
    },

    async monitors(workspaceId) {
      const data = await call(`/workspaces/${requireId(workspaceId)}/monitors`);
      return Array.isArray(data) ? data : Array.isArray(data?.monitors) ? data.monitors : [];
    },

    async createMonitor(workspaceId, payload) {
      const data = await call(`/workspaces/${requireId(workspaceId)}/monitors`, {
        method: 'POST',
        body: monitorPayload(payload),
      });
      return data ?? null;
    },

    async getMonitor(id) {
      const data = await call(`/monitors/${requireId(id)}`);
      return data ?? null;
    },

    async updateMonitor(id, patch) {
      const data = await call(`/monitors/${requireId(id)}`, {
        method: 'PATCH',
        body: monitorPayload(patch, { partial: true }),
      });
      return data ?? null;
    },

    async deleteMonitor(id) {
      await call(`/monitors/${requireId(id)}`, { method: 'DELETE' });
      return null;
    },

    async monitorRuns(id, { limit } = {}) {
      const params = new URLSearchParams();
      params.set('limit', String(requirePositiveInt(limit, 'limit', 50)));
      const data = await call(`/monitors/${requireId(id)}/runs?${params}`);
      return Array.isArray(data) ? data : Array.isArray(data?.runs) ? data.runs : [];
    },

    async runMonitor(id) {
      const data = await call(`/monitors/${requireId(id)}/run`, { method: 'POST' });
      return data ?? null;
    },

    /**
     * Newest-first comment page for one synced entity. `before` is the opaque
     * cursor from a previous page's `nextBefore`; null means there is no more.
     */
    async comments(workspaceId, { entityId, before, limit } = {}) {
      const params = new URLSearchParams();
      params.set('entityId', requiredString(entityId, 'entityId'));
      params.set('limit', String(requirePositiveInt(limit, 'limit', 50)));
      if (before !== undefined && before !== null && before !== '') {
        params.set('before', String(before));
      }
      const data = await call(`/workspaces/${requireId(workspaceId)}/comments?${params}`);
      return {
        comments: Array.isArray(data?.comments) ? data.comments : [],
        nextBefore: data?.nextBefore ?? null,
      };
    },

    async createComment(workspaceId, { entityId, body, mentions } = {}) {
      const payload = {
        entityId: requiredString(entityId, 'entityId'),
        body: commentBody(body),
      };
      if (mentions !== undefined && mentions !== null) payload.mentions = mentionIds(mentions);
      const data = await call(`/workspaces/${requireId(workspaceId)}/comments`, {
        method: 'POST',
        body: payload,
      });
      return data ?? null;
    },

    /** Patch a comment's text, mention set, and/or resolved state. */
    async updateComment(id, { body, resolved, mentions } = {}) {
      const patch = {};
      if (body !== undefined) patch.body = commentBody(body);
      if (resolved !== undefined) {
        if (typeof resolved !== 'boolean') {
          throw new TypeError('resolved must be a boolean');
        }
        patch.resolved = resolved;
      }
      if (mentions !== undefined && mentions !== null) patch.mentions = mentionIds(mentions);
      if (Object.keys(patch).length === 0) {
        throw new TypeError('updateComment requires body, resolved, or mentions');
      }
      const data = await call(`/comments/${requireId(id)}`, { method: 'PATCH', body: patch });
      return data ?? null;
    },

    /**
     * Comments in this workspace that mention the caller, newest first.
     * `before` is the opaque cursor from the previous page's `nextBefore`.
     */
    async mentions(workspaceId, { before, limit } = {}) {
      const params = new URLSearchParams();
      params.set('limit', String(requirePositiveInt(limit, 'limit', 50)));
      if (before !== undefined && before !== null && before !== '') {
        params.set('before', String(before));
      }
      const data = await call(`/workspaces/${requireId(workspaceId)}/mentions?${params}`);
      const cursor = data?.nextBefore;
      return {
        comments: Array.isArray(data?.comments) ? data.comments : [],
        nextBefore: cursor === undefined || cursor === null || cursor === '' ? null : cursor,
      };
    },

    async deleteComment(id) {
      await call(`/comments/${requireId(id)}`, { method: 'DELETE' });
      return null;
    },

    async status() {
      const signedIn = Boolean(accessToken || refreshToken) || Boolean(await storedRefreshToken());
      return { signedIn, user };
    },
  };
}
