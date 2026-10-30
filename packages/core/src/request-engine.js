import http from 'node:http';
import https from 'node:https';
import { isUtf8 } from 'node:buffer';
import { URL, URLSearchParams } from 'node:url';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { storeCookies, cookieHeaderFor } from './cookie-jar.js';
import { shouldBypass, createProxyAgent } from './proxy.js';
import {
  resolveAuth,
  needsChallenge,
  buildChallengeResponse,
} from './auth/index.js';

const DEFAULT_MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 52428800; // 50 MB, mirrors DEFAULT_NETWORK_SETTINGS

// Node names ISO-8859-1 `latin1`; servers routinely declare the IANA spelling.
const CHARSET_ALIASES = {
  'iso-8859-1': 'latin1',
  'iso8859-1': 'latin1',
  'latin-1': 'latin1',
};

/** Charset from a Content-Type header, falling back to utf8. */
export function parseCharset(contentType) {
  const m = /charset\s*=\s*"?([^";]+)"?/i.exec(contentType || '');
  const raw = (m?.[1] || 'utf8').trim().toLowerCase();
  const charset = CHARSET_ALIASES[raw] || raw;
  return Buffer.isEncoding(charset) ? charset : 'utf8';
}

/**
 * Is this Content-Type textual? A missing type returns true so the caller can
 * fall back to checking whether the bytes are valid UTF-8.
 */
export function isTextualContentType(contentType) {
  const ct = String(contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!ct) return true;
  return (
    /^text\//.test(ct) ||
    /^application\/(json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|problem\+json|ld\+json)$/.test(
      ct
    ) ||
    /\+json$/.test(ct) ||
    /\+xml$/.test(ct)
  );
}

/**
 * Send one HTTP request and return a structured response.
 * Runs in the Electron main (Node) process, so it is not subject to the
 * browser's CORS or mixed-content restrictions.
 *
 * `options` is the network context built by packages/core/src/network-runtime.js:
 *   { signal, followRedirects, maxRedirects, maxResponseBytes, proxy, tls,
 *     cookieJar }
 */
export async function sendRequest(request, options = {}) {
  const started = Date.now();
  // Cookie jar flows in via options.cookieJar; the engine threads it through
  // redirects and returns the updated jar so the caller can persist it.
  const jarRef = { jar: options.cookieJar || null };
  try {
    const result = await performWithRedirects(request, 0, [], jarRef, options);
    return {
      ok: true,
      ...result,
      timeMs: Date.now() - started,
      cookieJar: jarRef.jar, // updated jar (null if cookies disabled)
    };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : String(err),
      code: errorCode(err),
      timeMs: Date.now() - started,
    };
  }
}

// Abort/timeout cancellations carry no OS error code, so tag them here. The UI
// uses these tags to suppress test failures and show a clear message.
function errorCode(err) {
  if (err && err.code) return err.code;
  const message = err && err.message ? String(err.message) : '';
  if (message.startsWith('Request timed out after')) return 'ETIMEDOUT';
  if (message === 'Request aborted' || err?.name === 'AbortError') return 'ABORT_ERR';
  return undefined;
}


function buildUrl(rawUrl, params, authQuery) {
  let urlString = (rawUrl || '').trim();
  if (!/^https?:\/\//i.test(urlString)) {
    urlString = 'https://' + urlString;
  }
  const url = new URL(urlString);
  for (const p of params || []) {
    if (p && p.enabled !== false && p.key) {
      url.searchParams.append(p.key, p.value ?? '');
    }
  }
  for (const q of authQuery || []) {
    url.searchParams.append(q.key, q.value ?? '');
  }
  return url;
}

function buildHeaders(headerList, authHeaders) {
  const headers = {};
  for (const h of headerList || []) {
    if (h && h.enabled !== false && h.key) {
      headers[h.key] = h.value ?? '';
    }
  }
  for (const h of authHeaders || []) {
    headers[h.key] = h.value;
  }
  return headers;
}

// Merge challenge headers over the initial auth headers by (case-insensitive)
// key, so a Type 3 NTLM header replaces the Type 1 one instead of duplicating.
function mergeAuthHeaders(base, extra) {
  const out = [...(base || [])];
  for (const header of extra || []) {
    const index = out.findIndex((h) => h.key.toLowerCase() === header.key.toLowerCase());
    if (index >= 0) out[index] = header;
    else out.push(header);
  }
  return out;
}

// Build the URL-encoded body for an OAuth 2.0 token request. Supports
// client_credentials, password, authorization_code (PKCE) and refresh_token.
export function buildOAuth2TokenForm(cfg) {
  const o = cfg || {};
  const grantType = o.grantType || 'client_credentials';
  const form = new URLSearchParams();
  form.set('grant_type', grantType);
  if (o.scope) form.set('scope', o.scope);
  if (o.audience) form.set('audience', o.audience);

  if (grantType === 'password') {
    form.set('username', o.username || '');
    form.set('password', o.password || '');
  } else if (grantType === 'authorization_code') {
    form.set('code', o.code || '');
    if (o.redirectUri) form.set('redirect_uri', o.redirectUri);
    if (o.codeVerifier) form.set('code_verifier', o.codeVerifier);
  } else if (grantType === 'refresh_token') {
    form.set('refresh_token', o.refreshToken || '');
  }

  if (o.clientAuth !== 'basic') {
    if (o.clientId) form.set('client_id', o.clientId);
    if (o.clientSecret) form.set('client_secret', o.clientSecret);
  }

  const extra = o.extraParams;
  if (Array.isArray(extra)) {
    for (const item of extra) {
      if (item && item.enabled !== false && item.key) form.append(item.key, item.value ?? '');
    }
  } else if (extra && typeof extra === 'object') {
    for (const [key, value] of Object.entries(extra)) form.append(key, value ?? '');
  }
  return form;
}

// Fetch an OAuth 2.0 access token. Returns
// { ok, accessToken, refreshToken, tokenType, expiresIn, raw, error }.
export async function fetchOAuth2Token(cfg, options = {}) {
  const o = cfg || {};
  if (!o.accessTokenUrl) return { ok: false, error: 'Access Token URL is required' };

  const form = buildOAuth2TokenForm(o);
  const headers = [{ key: 'Content-Type', value: 'application/x-www-form-urlencoded', enabled: true }];
  if (o.clientAuth === 'basic') {
    const enc = Buffer.from(`${o.clientId || ''}:${o.clientSecret || ''}`, 'utf8').toString('base64');
    headers.push({ key: 'Authorization', value: `Basic ${enc}`, enabled: true });
  }

  const res = await sendRequest(
    {
      method: 'POST',
      url: o.accessTokenUrl,
      headers,
      params: [],
      body: { mode: 'raw', raw: form.toString() },
    },
    options
  );

  if (!res.ok) return { ok: false, error: res.error || 'Token request failed', raw: res };
  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    return { ok: false, error: `Token endpoint returned non-JSON (status ${res.status})`, raw: res };
  }
  const accessToken = parsed.access_token || parsed.accessToken || '';
  if (!accessToken) {
    return { ok: false, error: `No access_token in response (status ${res.status})`, raw: parsed };
  }
  return {
    ok: true,
    accessToken,
    refreshToken: parsed.refresh_token || parsed.refreshToken || '',
    tokenType: parsed.token_type || parsed.tokenType || 'Bearer',
    expiresIn: Number(parsed.expires_in ?? parsed.expiresIn ?? 0) || 0,
    raw: parsed,
    status: res.status,
  };
}

function buildBody(body, headers) {
  if (!body || body.mode === 'none' || body.mode == null) return null;

  if (body.mode === 'json') {
    ensureHeader(headers, 'Content-Type', 'application/json');
    return Buffer.from(body.raw ?? '', 'utf8');
  }
  if (body.mode === 'raw') {
    return Buffer.from(body.raw ?? '', 'utf8');
  }
  if (body.mode === 'graphql') {
    ensureHeader(headers, 'Content-Type', 'application/json');
    const gql = body.graphql || {};
    let variables = {};
    if (gql.variables && gql.variables.trim()) {
      try {
        variables = JSON.parse(gql.variables);
      } catch {
        // Invalid JSON variables -> send empty object rather than crashing.
        variables = {};
      }
    }
    return Buffer.from(JSON.stringify({ query: gql.query || '', variables }), 'utf8');
  }
  if (body.mode === 'form-urlencoded') {
    const sp = new URLSearchParams();
    for (const f of body.form || []) {
      if (f && f.enabled !== false && f.key) sp.append(f.key, f.value ?? '');
    }
    ensureHeader(headers, 'Content-Type', 'application/x-www-form-urlencoded');
    return Buffer.from(sp.toString(), 'utf8');
  }
  if (body.mode === 'form-data') {
    // Multipart supporting both text fields and file uploads. A field is a
    // file when type === 'file' and it has a filePath; the file bytes are read
    // from disk here in the Node main process.
    const boundary = '----RestTamerBoundary' + Math.random().toString(16).slice(2);
    const segments = []; // array of Buffers
    const push = (s) => segments.push(Buffer.from(s, 'utf8'));

    for (const f of body.form || []) {
      if (!f || f.enabled === false || !f.key) continue;
      if (f.type === 'file' && f.filePath) {
        let fileBuf;
        try {
          fileBuf = fs.readFileSync(f.filePath);
        } catch (e) {
          throw new Error(`Cannot read file for field "${f.key}": ${e.message}`);
        }
        const filename = f.fileName || path.basename(f.filePath);
        const ctype = f.contentType || guessContentType(filename);
        push(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${f.key}"; filename="${filename}"\r\n` +
            `Content-Type: ${ctype}\r\n\r\n`
        );
        segments.push(fileBuf);
        push('\r\n');
      } else {
        push(
          `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="${f.key}"\r\n\r\n` +
            `${f.value ?? ''}\r\n`
        );
      }
    }
    push(`--${boundary}--\r\n`);
    ensureHeader(headers, 'Content-Type', `multipart/form-data; boundary=${boundary}`);
    return Buffer.concat(segments);
  }
  return null;
}

// Human-readable body for the "sent" view; avoids dumping binary file bytes.
function describeSentBody(body, bodyBuffer) {
  if (!bodyBuffer) return '';
  if (body && body.mode === 'form-data' && (body.form || []).some((f) => f.type === 'file')) {
    const lines = (body.form || [])
      .filter((f) => f && f.enabled !== false && f.key)
      .map((f) =>
        f.type === 'file'
          ? `${f.key}: [file] ${f.fileName || f.filePath || ''}`
          : `${f.key}: ${f.value ?? ''}`
      );
    return `multipart/form-data (${bodyBuffer.length} bytes)\n` + lines.join('\n');
  }
  return bodyBuffer.toString('utf8');
}

function guessContentType(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const map = {
    json: 'application/json',
    txt: 'text/plain',
    csv: 'text/csv',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    zip: 'application/zip',
    xml: 'application/xml',
  };
  return map[ext] || 'application/octet-stream';
}

function ensureHeader(headers, name, value) {
  const exists = Object.keys(headers).some(
    (k) => k.toLowerCase() === name.toLowerCase()
  );
  if (!exists) headers[name] = value;
}

async function performWithRedirects(
  request,
  redirectCount,
  chain,
  jarRef,
  options = {},
  authState = { retried: false, headers: null }
) {
  if (options.signal?.aborted) {
    throw options.signal.reason || new Error('Request aborted');
  }

  const method = (request.method || 'GET').toUpperCase();
  const headers = buildHeaders(request.headers, []);
  // Build the body before auth: signing schemes (OAuth1, AWS SigV4) need the
  // exact bytes, and multipart boundaries depend on the headers.
  const bodyBuffer = buildBody(request.body, headers);
  if (bodyBuffer) headers['Content-Length'] = Buffer.byteLength(bodyBuffer);
  ensureHeader(headers, 'Accept-Encoding', 'gzip, deflate, br');

  let url;
  try {
    url = buildUrl(request.url, request.params, []);
  } catch {
    throw new Error(`Invalid URL: ${request.url}`);
  }

  // Auth is resolved after the URL and body exist so providers can sign them.
  let authResult;
  try {
    authResult = await resolveAuth(request.auth, {
      method,
      url: url.toString(),
      body: bodyBuffer,
      headers,
      // Auto-refresh inherits the request's proxy/TLS/abort context, but not
      // the cookie jar: the token endpoint is not the API being called.
      fetcher: (cfg) =>
        fetchOAuth2Token(cfg, {
          signal: options.signal,
          followRedirects: options.followRedirects,
          maxRedirects: options.maxRedirects,
          verifyTls: options.verifyTls,
          maxResponseBytes: options.maxResponseBytes,
          proxy: options.proxy,
          tls: options.tls,
        }),
    });
  } catch (err) {
    throw new Error(`Auth error: ${err?.message || err}`);
  }

  const authHeaders = mergeAuthHeaders(authResult.headers, authState.headers);
  for (const q of authResult.query || []) url.searchParams.append(q.key, q.value ?? '');
  for (const h of authHeaders) headers[h.key] = h.value;

  // Attach cookies from the jar (unless the request already sets Cookie).
  // `useCookieJar: false` opts this request out of both reading and writing
  // the shared jar, without affecting other requests.
  const useCookieJar = options.useCookieJar !== false;
  if (useCookieJar && jarRef && jarRef.jar) {
    const cookieHeader = cookieHeaderFor(jarRef.jar, url.toString());
    if (cookieHeader && !Object.keys(headers).some((k) => k.toLowerCase() === 'cookie')) {
      headers['Cookie'] = cookieHeader;
    }
  }

  // Connection timings for the final hop, relative to when the request starts.
  // Values stay null when the corresponding socket event never fires (for
  // example, DNS lookups for literal IPs or reused keep-alive sockets).
  const timings = {
    startMs: Date.now(),
    socketMs: null,
    dnsMs: null,
    connectMs: null,
    tlsMs: null,
    ttfbMs: null,
    totalMs: null,
  };

  return new Promise((resolve, reject) => {
    // Proxy is chosen per hop so a redirect to a bypassed host goes direct.
    const proxy =
      options.proxy && !shouldBypass(url.hostname, options.proxy.bypass) ? options.proxy : null;
    const agent = proxy ? createProxyAgent(url.toString(), proxy) : undefined;

    const transport = url.protocol === 'http:' ? http : https;
    const isHttps = url.protocol === 'https:';
    const requestOptions = {
      method,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers,
      agent,
      ...(isHttps ? options.tls : {}),
    };

    const req = transport.request(requestOptions, (res) => {
      timings.ttfbMs = Date.now() - timings.startMs;
      // Exactly one of resolve/reject wins per hop. Stream errors after that
      // are ignored (they are consequences of our own destroy calls).
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
        req.destroy();
      };

      const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
      if (
        options.followRedirects !== false &&
        [301, 302, 303, 307, 308].includes(res.statusCode) &&
        res.headers.location &&
        redirectCount < maxRedirects
      ) {
        settled = true;
        res.resume();
        const nextUrl = new URL(res.headers.location, url).toString();
        const nextMethod = res.statusCode === 303 ? 'GET' : request.method;
        // Store cookies set on the redirect response before following it.
        if (useCookieJar && jarRef && jarRef.jar && res.headers['set-cookie']) {
          jarRef.jar = storeCookies(jarRef.jar, res.headers['set-cookie'], url.toString());
        }
        performWithRedirects(
          { ...request, url: nextUrl, method: nextMethod, params: [], auth: { type: 'none' } },
          redirectCount + 1,
          [...chain, { from: url.toString(), status: res.statusCode, to: nextUrl }],
          jarRef,
          options
        ).then(resolve, reject);
        return;
      }

      // Digest/NTLM need the server challenge. Retry exactly once with the
      // challenge response; a second 401 is returned to the caller as-is.
      if (
        res.statusCode === 401 &&
        !authState.retried &&
        needsChallenge(request.auth?.type) &&
        res.headers['www-authenticate']
      ) {
        let challengeHeaders = [];
        try {
          challengeHeaders = buildChallengeResponse(request.auth, res.headers['www-authenticate'], {
            method,
            url: url.toString(),
            body: bodyBuffer,
            headers,
          });
        } catch {
          challengeHeaders = [];
        }
        if (challengeHeaders.length) {
          settled = true;
          res.resume();
          if (useCookieJar && jarRef && jarRef.jar && res.headers['set-cookie']) {
            jarRef.jar = storeCookies(jarRef.jar, res.headers['set-cookie'], url.toString());
          }
          performWithRedirects(request, redirectCount, chain, jarRef, options, {
            retried: true,
            headers: challengeHeaders,
          }).then(resolve, reject);
          return;
        }
      }

      const chunks = [];
      const maxBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
      let receivedBytes = 0;

      res.on('data', (c) => {
        if (settled) return;
        receivedBytes += c.length;
        // A truncated "success" would be worse than an error: fail loudly.
        if (receivedBytes > maxBytes) {
          fail(new Error(`Response exceeds ${maxBytes} bytes`));
          return;
        }
        chunks.push(c);
      });
      res.on('error', (err) => fail(err));
      res.on('end', () => {
        if (settled) return;
        settled = true;
        let raw = Buffer.concat(chunks);
        raw = decompress(raw, res.headers['content-encoding']);
        const contentType = res.headers['content-type'] || '';
        const charset = parseCharset(contentType);
        const textual = isTextualContentType(contentType);
        // Binary = explicitly non-textual, or textual but not valid UTF-8.
        const isBinary = raw.length > 0 && (!textual || !isUtf8(raw));
        const body = isBinary ? '' : raw.toString(charset);
        const bodyBase64 = isBinary ? raw.toString('base64') : '';
        // Store any cookies from the final response into the jar.
        if (useCookieJar && jarRef && jarRef.jar && res.headers['set-cookie']) {
          jarRef.jar = storeCookies(jarRef.jar, res.headers['set-cookie'], url.toString());
        }
        timings.totalMs = Date.now() - timings.startMs;
        resolve({
          status: res.statusCode,
          statusText: res.statusMessage || '',
          headers: flattenHeaders(res.headers),
          cookies: parseCookies(res.headers['set-cookie']),
          body,
          bodyBase64,
          isBinary,
          charset,
          size: raw.length,
          contentType,
          finalUrl: url.toString(),
          redirects: chain,
          timings,
          tlsInsecure: isHttps && options.tls?.rejectUnauthorized === false,
          // Exactly what we sent, for the "Request Sent" diagnostic view.
          // For multipart with files, show a summary instead of raw bytes.
          sent: {
            method: requestOptions.method,
            url: url.toString(),
            headers: Object.entries(headers).map(([key, value]) => ({ key, value: String(value) })),
            body: describeSentBody(request.body, bodyBuffer),
          },
        });
      });
    });

    // Derive connection timings from the socket lifecycle. A reused socket
    // never emits lookup/connect/secureConnect, so those stay null.
    req.on('socket', (socket) => {
      timings.socketMs = Date.now() - timings.startMs;
      if (!socket.connecting) return;
      socket.once('lookup', () => {
        timings.dnsMs = Date.now() - timings.startMs;
      });
      socket.once('connect', () => {
        timings.connectMs = Date.now() - timings.startMs;
      });
      if (isHttps) {
        socket.once('secureConnect', () => {
          timings.tlsMs = Date.now() - timings.startMs;
        });
      }
    });

    req.on('error', (err) => reject(err));

    // Cancellation: the network-runtime controller owns timeouts, so aborting
    // the signal is the single way to stop a request in flight. Reject first
    // (destroying alone can leave a half-open response with no end/error).
    const signal = options.signal;
    const onAbort = () => {
      reject(signal.reason || new Error('Request aborted'));
      req.destroy();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const cleanupSignal = () => signal?.removeEventListener('abort', onAbort);
    req.on('close', cleanupSignal);

    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

function parseCookies(setCookie) {
  if (!setCookie) return [];
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  return list.map((raw) => {
    const segments = raw.split(';').map((s) => s.trim());
    const [nameValue, ...attrs] = segments;
    const eq = nameValue.indexOf('=');
    const name = eq >= 0 ? nameValue.slice(0, eq) : nameValue;
    const value = eq >= 0 ? nameValue.slice(eq + 1) : '';
    const attrMap = {};
    for (const a of attrs) {
      const [k, v] = a.split('=');
      attrMap[k.toLowerCase()] = v ?? true;
    }
    return {
      name,
      value,
      domain: attrMap.domain || '',
      path: attrMap.path || '/',
      expires: attrMap.expires || '',
      httpOnly: 'httponly' in attrMap,
      secure: 'secure' in attrMap,
    };
  });
}

function decompress(buffer, encoding) {
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(buffer);
    if (encoding === 'deflate') return zlib.inflateSync(buffer);
    if (encoding === 'br') return zlib.brotliDecompressSync(buffer);
  } catch {
    // fall through to raw bytes
  }
  return buffer;
}

function flattenHeaders(headers) {
  const out = [];
  for (const [key, value] of Object.entries(headers)) {
    out.push({ key, value: Array.isArray(value) ? value.join(', ') : value });
  }
  return out;
}
