// In-memory OAuth2 token cache, keyed by a stable hash of the auth config.
//
// Encrypted persistence (safeStorage, per workspace) is deliberately left to
// Fase 3.4; tokens must never be written to the renderer data file or logs.
// The process-local cache is enough to refresh across requests in one session.
import crypto from 'node:crypto';

const entries = new Map();

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/**
 * Identity of an OAuth2 client config. Tokens themselves are excluded so the
 * key is stable before and after a token is stored.
 */
export function authKey(cfg) {
  const o = cfg?.oauth2 || cfg || {};
  return crypto
    .createHash('sha256')
    .update(
      stableStringify({
        authUrl: o.authUrl || o.authorizationUrl || '',
        accessTokenUrl: o.accessTokenUrl || '',
        clientId: o.clientId || '',
        clientSecret: o.clientSecret || '',
        scope: o.scope || '',
        audience: o.audience || '',
        grantType: o.grantType || '',
        username: o.username || '',
      })
    )
    .digest('hex');
}

export function get(key) {
  return entries.get(key) || null;
}

/**
 * Store a token. `token` may be the normalized result object or a bare string.
 * An absent `expiresAt` means "no known expiry" (never expires locally).
 */
export function set(key, token, expiresAt = null) {
  if (!key) return null;
  const normalized =
    typeof token === 'string'
      ? { accessToken: token }
      : { ...(token || {}) };
  const entry = {
    accessToken: normalized.accessToken || '',
    refreshToken: normalized.refreshToken || '',
    tokenType: normalized.tokenType || 'Bearer',
    expiresAt:
      expiresAt ?? (normalized.expiresAt != null ? Number(normalized.expiresAt) : null),
  };
  entries.set(key, entry);
  return entry;
}

export function remove(key) {
  entries.delete(key);
}

/**
 * Is the entry expired? `skewMs` treats tokens near expiry as expired so a
 * request does not start with a token that dies in flight. An entry without
 * `expiresAt` is treated as non-expiring.
 *
 * `now` is injectable for deterministic tests.
 */
export function isExpired(entry, skewMs = 30000, now = Date.now()) {
  if (!entry) return true;
  if (entry.expiresAt == null) return false;
  return now + skewMs >= Number(entry.expiresAt);
}

export function clear() {
  entries.clear();
}

export function size() {
  return entries.size;
}
