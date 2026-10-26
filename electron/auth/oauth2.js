// OAuth 2.0 helpers: PKCE, authorization URL, loopback redirect listener and
// token exchange/refresh. No Electron imports — main.js injects the browser
// opener and the network-aware token fetcher, so this module is unit-testable.
import http from 'node:http';
import crypto from 'node:crypto';

const DEFAULT_CALLBACK_PATH = '/callback';
const DEFAULT_TIMEOUT_MS = 120000;

// ---------------------------------------------------------------------------
// PKCE (RFC 7636) and state
// ---------------------------------------------------------------------------

export function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

export function pkceChallenge(verifier) {
  return base64url(crypto.createHash('sha256').update(verifier).digest());
}

export function createPkcePair() {
  // 32 random bytes -> 43 base64url chars, within RFC 7636's 43..128 range.
  const verifier = base64url(crypto.randomBytes(32));
  return { verifier, challenge: pkceChallenge(verifier), method: 'S256' };
}

export function randomState() {
  return base64url(crypto.randomBytes(16));
}

// ---------------------------------------------------------------------------
// Authorization URL
// ---------------------------------------------------------------------------

function extraParams(cfg) {
  const raw = cfg?.extraParams;
  const out = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && item.enabled !== false && item.key) out.push([item.key, item.value ?? '']);
    }
  } else if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) out.push([key, value ?? '']);
  }
  return out;
}

export function buildAuthorizeUrl({ cfg, state, codeChallenge, redirectUri }) {
  const o = cfg?.oauth2 || cfg || {};
  const authUrl = o.authUrl || o.authorizationUrl || '';
  if (!authUrl) throw new Error('OAuth2 authorization URL is required');
  if (!o.clientId) throw new Error('OAuth2 Client ID is required');
  if (!codeChallenge) throw new Error('PKCE code challenge is required');

  const url = new URL(authUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', o.clientId);
  if (redirectUri) url.searchParams.set('redirect_uri', redirectUri);
  if (state) url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (o.scope) url.searchParams.set('scope', o.scope);
  if (o.audience) url.searchParams.set('audience', o.audience);
  for (const [key, value] of extraParams(o)) {
    if (!key) continue;
    url.searchParams.set(key, value);
  }
  return url.toString();
}

// ---------------------------------------------------------------------------
// Loopback redirect listener
// ---------------------------------------------------------------------------

/**
 * Bind 127.0.0.1 on an ephemeral port and wait for the OAuth redirect.
 * Returns { redirectUri, wait, close } where `wait` resolves with the code.
 * The listener is single-use, validates `state`, rejects on error responses,
 * and times out after `timeoutMs` (default 120 s).
 */
export async function startLoopbackServer({
  state,
  onCode,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  host = '127.0.0.1',
} = {}) {
  let settle;
  let fail;
  let settled = false;
  const wait = new Promise((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const finish = (fn, value) => {
    if (settled) return false;
    settled = true;
    clearTimeout(timer);
    fn(value);
    return true;
  };

  const server = http.createServer((req, res) => {
    const respond = (status, message) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(message);
    };

    let url;
    try {
      url = new URL(req.url, `http://${host}`);
    } catch {
      respond(400, 'Invalid callback URL');
      return;
    }
    if (url.pathname !== DEFAULT_CALLBACK_PATH) {
      respond(404, 'Not found');
      return;
    }
    if (settled) {
      respond(409, 'Authorization already completed');
      return;
    }

    const error = url.searchParams.get('error');
    if (error) {
      const description = url.searchParams.get('error_description') || '';
      respond(400, 'Authorization failed');
      finish(fail, new Error(`OAuth authorization failed: ${error}${description ? ` (${description})` : ''}`));
      return;
    }

    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    if (!code) {
      respond(400, 'Missing authorization code');
      finish(fail, new Error('OAuth callback is missing the authorization code'));
      return;
    }
    if (state != null && returnedState !== state) {
      respond(400, 'State mismatch');
      finish(fail, new Error('OAuth state mismatch'));
      return;
    }

    respond(200, 'Authorization complete. You can close this tab and return to Relay.');
    finish(settle, code);
    if (typeof onCode === 'function') {
      try {
        onCode(code);
      } catch {
        /* the caller owns callback errors */
      }
    }
  });

  const timer = setTimeout(() => {
    finish(fail, new Error('OAuth authorization timed out'));
    server.close();
  }, timeoutMs);
  timer.unref?.();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });

  const { port } = server.address();
  const redirectUri = `http://${host}:${port}${DEFAULT_CALLBACK_PATH}`;

  return {
    redirectUri,
    wait,
    close: () => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        fail(new Error('OAuth authorization cancelled'));
      }
      server.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Token endpoint calls
// ---------------------------------------------------------------------------

async function defaultFetcher(cfg) {
  // Lazy import avoids a static cycle: request-engine imports auth/index,
  // which imports this module. At call time the engine is fully initialized.
  const { fetchOAuth2Token } = await import('../request-engine.js');
  return fetchOAuth2Token(cfg);
}

function normalizeTokenResult(res, now, fallbackRefreshToken = '') {
  if (!res) return { ok: false, error: 'Token request failed' };
  if (res.ok === false) {
    return { ok: false, error: res.error || 'Token request failed', raw: res.raw };
  }
  if (res.accessToken) {
    const expiresIn = Number(res.expiresIn ?? res.raw?.expires_in ?? 0) || 0;
    return {
      ok: true,
      accessToken: res.accessToken,
      refreshToken: res.refreshToken || fallbackRefreshToken || '',
      tokenType: res.tokenType || 'Bearer',
      expiresIn,
      expiresAt: expiresAtFrom(expiresIn, now),
      raw: res.raw,
    };
  }

  let parsed = res;
  if (typeof res === 'string') {
    try {
      parsed = JSON.parse(res);
    } catch {
      return { ok: false, error: 'Token endpoint returned non-JSON' };
    }
  }
  const accessToken = parsed.access_token || parsed.accessToken || '';
  if (!accessToken) return { ok: false, error: 'No access_token in token response', raw: parsed };
  const expiresIn = Number(parsed.expires_in ?? parsed.expiresIn ?? 0) || 0;
  return {
    ok: true,
    accessToken,
    refreshToken: parsed.refresh_token || parsed.refreshToken || fallbackRefreshToken || '',
    tokenType: parsed.token_type || parsed.tokenType || 'Bearer',
    expiresIn,
    expiresAt: expiresAtFrom(expiresIn, now),
    raw: parsed,
  };
}

function expiresAtFrom(expiresIn, now) {
  return expiresIn > 0 ? now + expiresIn * 1000 : null;
}

async function tokenRequest({ cfg, overrides, fetcher, now, fallbackRefreshToken }) {
  const merged = { ...(cfg || {}), ...(overrides || {}) };
  const result = fetcher ? await fetcher(merged) : await defaultFetcher(merged);
  return normalizeTokenResult(result, now, fallbackRefreshToken ?? cfg?.refreshToken ?? '');
}

export async function exchangeCode({
  cfg,
  code,
  verifier,
  redirectUri,
  fetcher,
  now = Date.now(),
}) {
  if (!code) return { ok: false, error: 'Authorization code is required' };
  return tokenRequest({
    cfg,
    overrides: {
      grantType: 'authorization_code',
      code,
      codeVerifier: verifier || '',
      redirectUri: redirectUri || '',
    },
    fetcher,
    now,
  });
}

export async function refreshToken({
  cfg,
  refreshToken: refresh,
  fetcher,
  now = Date.now(),
}) {
  const value = refresh || cfg?.refreshToken || '';
  if (!value) return { ok: false, error: 'No refresh token available' };
  return tokenRequest({
    cfg,
    overrides: { grantType: 'refresh_token', refreshToken: value },
    fetcher,
    now,
    fallbackRefreshToken: value,
  });
}
