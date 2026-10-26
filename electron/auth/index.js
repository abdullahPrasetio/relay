// Public auth surface used by the request engine and main process.
// No Electron imports: everything here is unit-testable with plain Node.
import {
  applyAuth,
  buildChallengeResponse,
  getProvider,
  needsChallenge,
  providerTypes,
} from './providers.js';
import {
  buildAuthorizeUrl,
  createPkcePair,
  exchangeCode,
  randomState,
  refreshToken,
  startLoopbackServer,
} from './oauth2.js';
import * as tokenCache from './token-cache.js';

export { applyAuth, buildChallengeResponse, needsChallenge, providerTypes, getProvider };
export { tokenCache };

const TOKEN_SKEW_MS = 30000;

function bearerHeaders(token, cfg) {
  if (!token?.accessToken) return { headers: [], query: [] };
  const prefix = cfg?.headerPrefix || token.tokenType || 'Bearer';
  return {
    headers: [{ key: 'Authorization', value: `${prefix} ${token.accessToken}`.trim() }],
    query: [],
  };
}

function cachedEntryFor(cfg) {
  const key = tokenCache.authKey(cfg);
  const cached = tokenCache.get(key);
  if (cached) return { key, entry: cached };
  // A config imported with an access token has no cache entry yet; treat the
  // stored value as a non-expiring fallback so behaviour matches Fase 1.
  if (cfg?.accessToken) {
    return {
      key,
      entry: {
        accessToken: cfg.accessToken,
        refreshToken: cfg.refreshToken || '',
        tokenType: cfg.tokenType || 'Bearer',
        expiresAt: cfg.expiresAt != null ? Number(cfg.expiresAt) : null,
      },
    };
  }
  return { key, entry: null };
}

/**
 * Resolve an auth config into headers/query. OAuth2 additionally consults the
 * token cache and refreshes an expired token when a refresh token is known.
 *
 * `ctx` may carry `{ method, url, body, headers, fetcher, now }`; `fetcher`
 * and `now` are injection points for tests and the main process.
 */
export async function resolveAuth(auth, ctx = {}) {
  if (!auth || auth.type === 'none' || auth.type === 'inherit') {
    return { headers: [], query: [] };
  }

  if (auth.type === 'oauth2') {
    const cfg = auth.oauth2 || {};
    const { key, entry } = cachedEntryFor(cfg);
    const now = ctx.now ?? Date.now();

    if (entry?.accessToken && !tokenCache.isExpired(entry, TOKEN_SKEW_MS, now)) {
      return bearerHeaders(entry, cfg);
    }

    const refresh = entry?.refreshToken || cfg.refreshToken;
    if (refresh) {
      try {
        const result = await refreshToken({ cfg, refreshToken: refresh, fetcher: ctx.fetcher, now });
        if (result.ok) {
          tokenCache.set(key, result, result.expiresAt);
          return bearerHeaders(result, cfg);
        }
      } catch {
        // Refresh failures fall through to the stored token; the server will
        // answer 401 and the UI shows it. Never surface token values here.
      }
    }

    if (entry?.accessToken) return bearerHeaders(entry, cfg);
    return { headers: [], query: [] };
  }

  return applyAuth(auth, ctx);
}

/** Store a token result for later requests; used after token/authorize IPC. */
export function rememberOAuth2Token(cfg, tokenResult) {
  if (!tokenResult?.ok) return null;
  const key = tokenCache.authKey(cfg);
  const expiresAt =
    tokenResult.expiresAt ??
    (tokenResult.expiresIn > 0 ? Date.now() + tokenResult.expiresIn * 1000 : null);
  return tokenCache.set(key, tokenResult, expiresAt);
}

/**
 * Token status for the UI. Never returns the token itself — only whether one
 * exists and when it expires.
 */
export function getOAuth2Status(cfg) {
  const { entry } = cachedEntryFor(cfg || {});
  if (!entry) {
    return {
      hasToken: false,
      expiresAt: null,
      expired: null,
      hasRefreshToken: false,
      tokenType: null,
    };
  }
  return {
    hasToken: Boolean(entry.accessToken),
    expiresAt: entry.expiresAt ?? null,
    expired: entry.accessToken ? tokenCache.isExpired(entry) : null,
    hasRefreshToken: Boolean(entry.refreshToken),
    tokenType: entry.tokenType || null,
  };
}

/**
 * Full authorization-code + PKCE flow:
 *   1. bind loopback listener  2. open the browser  3. wait for the code
 *   4. exchange it  5. cache the result.
 * `openBrowser` is injected (shell.openExternal in main); `fetcher` should be
 * network-aware so proxy/TLS settings apply to the token call.
 */
export async function authorizeOAuth2(cfg, { openBrowser, fetcher, timeoutMs } = {}) {
  if (typeof openBrowser !== 'function') {
    return { ok: false, error: 'Browser opener is not available' };
  }
  const state = randomState();
  const pkce = createPkcePair();
  let server;
  try {
    server = await startLoopbackServer({ state, timeoutMs });
    const authorizeUrl = buildAuthorizeUrl({
      cfg,
      state,
      codeChallenge: pkce.challenge,
      redirectUri: server.redirectUri,
    });
    await openBrowser(authorizeUrl);
    const code = await server.wait;
    const result = await exchangeCode({
      cfg,
      code,
      verifier: pkce.verifier,
      redirectUri: server.redirectUri,
      fetcher,
    });
    if (result.ok) rememberOAuth2Token(cfg, result);
    return result;
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    server?.close();
  }
}
