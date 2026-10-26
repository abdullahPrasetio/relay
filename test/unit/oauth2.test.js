import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAuthorizeUrl,
  createPkcePair,
  exchangeCode,
  pkceChallenge,
  randomState,
  refreshToken,
  startLoopbackServer,
} from '../../electron/auth/oauth2.js';
import {
  authorizeOAuth2,
  getOAuth2Status,
  rememberOAuth2Token,
  resolveAuth,
} from '../../electron/auth/index.js';
import { authKey, clear, get, isExpired, set } from '../../electron/auth/token-cache.js';
import { fetchOAuth2Token } from '../../electron/request-engine.js';

const servers = [];

function startServer(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

afterEach(async () => {
  clear();
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
  }
});

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

describe('PKCE and state', () => {
  it('matches the RFC 7636 appendix B PKCE vector', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    );
  });

  it('creates a 43+ char verifier and matching S256 challenge', () => {
    const pair = createPkcePair();
    expect(pair.method).toBe('S256');
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.verifier.length).toBeLessThanOrEqual(128);
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pair.challenge).toBe(pkceChallenge(pair.verifier));
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('creates a random state', () => {
    const a = randomState();
    const b = randomState();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('authorization URL', () => {
  it('includes PKCE, scope, audience and extra params', () => {
    const url = new URL(
      buildAuthorizeUrl({
        cfg: {
          authUrl: 'https://idp.example.com/authorize?prompt=login',
          clientId: 'client-1',
          scope: 'openid profile',
          audience: 'https://api.example.com',
          extraParams: [
            { key: 'access_type', value: 'offline', enabled: true },
            { key: 'ignored', value: 'x', enabled: false },
          ],
        },
        state: 'state-123',
        codeChallenge: 'challenge-abc',
        redirectUri: 'http://127.0.0.1:4444/callback',
      })
    );
    expect(url.origin + url.pathname).toBe('https://idp.example.com/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:4444/callback');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-abc');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('openid profile');
    expect(url.searchParams.get('audience')).toBe('https://api.example.com');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.has('ignored')).toBe(false);
    expect(url.searchParams.get('prompt')).toBe('login');
  });

  it('requires an authorization URL and client id', () => {
    expect(() =>
      buildAuthorizeUrl({ cfg: { clientId: 'x' }, codeChallenge: 'c' })
    ).toThrow(/authorization URL/);
    expect(() =>
      buildAuthorizeUrl({ cfg: { authUrl: 'https://a' }, codeChallenge: 'c' })
    ).toThrow(/Client ID/);
  });
});

describe('loopback server', () => {
  it('resolves the code on a matching state and is single-use', async () => {
    const server = await startLoopbackServer({ state: 'abc' });
    try {
      const res = await fetch(`${server.redirectUri}?code=the-code&state=abc`);
      expect(res.status).toBe(200);
      await expect(server.wait).resolves.toBe('the-code');

      const again = await fetch(`${server.redirectUri}?code=other&state=abc`);
      expect(again.status).toBe(409);
    } finally {
      server.close();
    }
  });

  it('rejects a mismatched state', async () => {
    const server = await startLoopbackServer({ state: 'expected' });
    const rejected = expect(server.wait).rejects.toThrow(/state mismatch/i);
    try {
      const res = await fetch(`${server.redirectUri}?code=c&state=wrong`);
      expect(res.status).toBe(400);
      await rejected;
    } finally {
      server.close();
    }
  });

  it('rejects on timeout and closes the listener', async () => {
    const server = await startLoopbackServer({ state: 's', timeoutMs: 40 });
    const rejected = expect(server.wait).rejects.toThrow(/timed out/);
    await rejected;
    server.close();
  });

  it('rejects an error redirect', async () => {
    const server = await startLoopbackServer({ state: 's' });
    const rejected = expect(server.wait).rejects.toThrow(/access_denied/);
    try {
      await fetch(`${server.redirectUri}?error=access_denied&state=s`);
      await rejected;
    } finally {
      server.close();
    }
  });
});

describe('token exchange and refresh against a mock IdP', () => {
  it('exchanges an authorization code and refreshes the token', async () => {
    let tokenCalls = 0;
    const { port } = await startServer(async (req, res) => {
      tokenCalls += 1;
      const body = new URLSearchParams(await readBody(req));
      let payload;
      if (body.get('grant_type') === 'authorization_code') {
        expect(body.get('code')).toBe('the-code');
        expect(body.get('code_verifier')).toBe('the-verifier');
        expect(body.get('redirect_uri')).toBe('http://127.0.0.1:9999/callback');
        expect(body.get('client_id')).toBe('client-1');
        payload = { access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer', expires_in: 3600 };
      } else {
        expect(body.get('grant_type')).toBe('refresh_token');
        expect(body.get('refresh_token')).toBe('rt-1');
        payload = { access_token: 'at-2', expires_in: 120 };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });

    const cfg = {
      accessTokenUrl: `http://127.0.0.1:${port}/token`,
      clientId: 'client-1',
      clientSecret: 'secret',
    };
    const fetcher = (c) => fetchOAuth2Token(c);

    const exchanged = await exchangeCode({
      cfg,
      code: 'the-code',
      verifier: 'the-verifier',
      redirectUri: 'http://127.0.0.1:9999/callback',
      fetcher,
      now: 1_000_000,
    });
    expect(exchanged.ok).toBe(true);
    expect(exchanged.accessToken).toBe('at-1');
    expect(exchanged.refreshToken).toBe('rt-1');
    expect(exchanged.tokenType).toBe('Bearer');
    expect(exchanged.expiresAt).toBe(1_000_000 + 3600 * 1000);

    const refreshed = await refreshToken({
      cfg,
      refreshToken: 'rt-1',
      fetcher,
      now: 2_000_000,
    });
    expect(refreshed.ok).toBe(true);
    expect(refreshed.accessToken).toBe('at-2');
    // IdPs that omit a new refresh token keep the previous one.
    expect(refreshed.refreshToken).toBe('rt-1');
    expect(refreshed.expiresAt).toBe(2_000_000 + 120 * 1000);
    expect(tokenCalls).toBe(2);
  });

  it('runs the full authorize flow with an injected browser opener', async () => {
    let tokenBody = null;
    const { port } = await startServer(async (req, res) => {
      tokenBody = new URLSearchParams(await readBody(req));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'authorized-token', refresh_token: 'r', expires_in: 60 }));
    });

    const cfg = {
      authUrl: `http://127.0.0.1:${port}/authorize`,
      accessTokenUrl: `http://127.0.0.1:${port}/token`,
      clientId: 'client-1',
    };
    let authorizeUrl = null;
    const result = await authorizeOAuth2(cfg, {
      openBrowser: async (url) => {
        authorizeUrl = new URL(url);
        const redirect = new URL(authorizeUrl.searchParams.get('redirect_uri'));
        redirect.searchParams.set('code', 'browser-code');
        redirect.searchParams.set('state', authorizeUrl.searchParams.get('state'));
        await fetch(redirect.toString());
      },
      fetcher: (c) => fetchOAuth2Token(c),
    });

    expect(result.ok).toBe(true);
    expect(result.accessToken).toBe('authorized-token');
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizeUrl.searchParams.get('state')).toBeTruthy();
    expect(tokenBody.get('code')).toBe('browser-code');
    expect(tokenBody.get('grant_type')).toBe('authorization_code');
    expect(tokenBody.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,}$/);

    const status = getOAuth2Status(cfg);
    expect(status.hasToken).toBe(true);
    expect(status.hasRefreshToken).toBe(true);
  });
});

describe('token cache and resolveAuth refresh', () => {
  it('stores entries and honours the expiry skew with an injected clock', () => {
    const key = authKey({ clientId: 'c', accessTokenUrl: 'https://idp/token' });
    expect(get(key)).toBeNull();
    set(key, { accessToken: 't', refreshToken: 'r', tokenType: 'Bearer' }, 100_000);
    expect(get(key).accessToken).toBe('t');

    expect(isExpired(get(key), 30_000, 0)).toBe(false);
    // Within the 30 s skew of expiry counts as expired.
    expect(isExpired(get(key), 30_000, 70_000)).toBe(true);
    expect(isExpired(get(key), 0, 99_999)).toBe(false);
    expect(isExpired(null)).toBe(true);

    clear();
    expect(get(key)).toBeNull();
  });

  it('uses a valid cached token without calling the fetcher', async () => {
    const cfg = { accessTokenUrl: 'https://idp/token', clientId: 'c' };
    set(authKey(cfg), { accessToken: 'cached', tokenType: 'Bearer' }, Date.now() + 60_000);
    let calls = 0;
    const result = await resolveAuth(
      { type: 'oauth2', oauth2: cfg },
      { fetcher: async () => { calls += 1; return { ok: true, accessToken: 'new' }; } }
    );
    expect(result.headers).toEqual([{ key: 'Authorization', value: 'Bearer cached' }]);
    expect(calls).toBe(0);
  });

  it('refreshes an expired token and stores the replacement', async () => {
    const cfg = {
      accessTokenUrl: 'https://idp/token',
      clientId: 'c',
      scope: 'api',
    };
    const key = authKey(cfg);
    set(key, { accessToken: 'old', refreshToken: 'refresh-1', tokenType: 'Bearer' }, 1_000);

    const seen = [];
    const result = await resolveAuth(
      { type: 'oauth2', oauth2: cfg },
      {
        now: 10_000_000,
        fetcher: async (merged) => {
          seen.push(merged);
          return {
            ok: true,
            accessToken: 'new',
            refreshToken: 'refresh-2',
            tokenType: 'Bearer',
            expiresIn: 3600,
          };
        },
      }
    );

    expect(seen[0].grantType).toBe('refresh_token');
    expect(seen[0].refreshToken).toBe('refresh-1');
    expect(result.headers).toEqual([{ key: 'Authorization', value: 'Bearer new' }]);
    expect(get(key).accessToken).toBe('new');
    expect(get(key).refreshToken).toBe('refresh-2');
    expect(get(key).expiresAt).toBe(10_000_000 + 3600 * 1000);
  });

  it('falls back to the stored token when refresh fails', async () => {
    const cfg = { accessTokenUrl: 'https://idp/token', clientId: 'c' };
    set(authKey(cfg), { accessToken: 'stale', refreshToken: 'r' }, 1_000);
    const result = await resolveAuth(
      { type: 'oauth2', oauth2: cfg },
      {
        now: 10_000_000,
        fetcher: async () => ({ ok: false, error: 'nope' }),
      }
    );
    expect(result.headers).toEqual([{ key: 'Authorization', value: 'Bearer stale' }]);
  });

  it('reports status without exposing the token', () => {
    const cfg = { accessTokenUrl: 'https://idp/token', clientId: 'status-client' };
    rememberOAuth2Token(cfg, { ok: true, accessToken: 'secret', refreshToken: 'r', expiresIn: 60 });
    const status = getOAuth2Status(cfg);
    expect(status.hasToken).toBe(true);
    expect(status.hasRefreshToken).toBe(true);
    expect(status.expired).toBe(false);
    expect(status).not.toHaveProperty('accessToken');
  });
});
