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

    async members(workspaceId) {
      return call(`/workspaces/${requireId(workspaceId)}/members`);
    },

    async status() {
      const signedIn = Boolean(accessToken || refreshToken) || Boolean(await storedRefreshToken());
      return { signedIn, user };
    },
  };
}
