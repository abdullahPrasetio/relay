import http from 'node:http';
import https from 'node:https';
import { URL, URLSearchParams } from 'node:url';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { storeCookies, cookieHeaderFor } from './cookie-jar.js';

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Send one HTTP request and return a structured response.
 * Runs in the Electron main (Node) process, so it is not subject to the
 * browser's CORS or mixed-content restrictions.
 */
export async function sendRequest(request, options = {}) {
  const started = Date.now();
  // Cookie jar flows in via options.cookieJar; the engine threads it through
  // redirects and returns the updated jar so the caller can persist it.
  const jarRef = { jar: options.cookieJar || null };
  try {
    const result = await performWithRedirects(request, 0, [], jarRef);
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
      code: err && err.code ? err.code : undefined,
      timeMs: Date.now() - started,
    };
  }
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

// Translate the request's auth config into headers and/or query params.
function applyAuth(auth) {
  const result = { headers: [], query: [] };
  if (!auth || auth.type === 'none') return result;

  if (auth.type === 'bearer' && auth.bearer?.token) {
    result.headers.push({ key: 'Authorization', value: `Bearer ${auth.bearer.token}` });
  } else if (auth.type === 'basic') {
    const u = auth.basic?.username ?? '';
    const p = auth.basic?.password ?? '';
    const encoded = Buffer.from(`${u}:${p}`, 'utf8').toString('base64');
    result.headers.push({ key: 'Authorization', value: `Basic ${encoded}` });
  } else if (auth.type === 'apikey' && auth.apikey?.key) {
    const entry = { key: auth.apikey.key, value: auth.apikey.value ?? '' };
    if (auth.apikey.addTo === 'query') result.query.push(entry);
    else result.headers.push(entry);
  } else if (auth.type === 'oauth2' && auth.oauth2?.accessToken) {
    const prefix = auth.oauth2.headerPrefix || 'Bearer';
    result.headers.push({
      key: 'Authorization',
      value: `${prefix} ${auth.oauth2.accessToken}`.trim(),
    });
  }
  return result;
}

// Fetch an OAuth 2.0 access token (client_credentials or password grant).
// Returns { ok, accessToken, raw, error }.
export async function fetchOAuth2Token(cfg) {
  const o = cfg || {};
  if (!o.accessTokenUrl) return { ok: false, error: 'Access Token URL is required' };

  const form = new URLSearchParams();
  form.set('grant_type', o.grantType || 'client_credentials');
  if (o.scope) form.set('scope', o.scope);
  if (o.grantType === 'password') {
    form.set('username', o.username || '');
    form.set('password', o.password || '');
  }

  const headers = [{ key: 'Content-Type', value: 'application/x-www-form-urlencoded', enabled: true }];
  if (o.clientAuth === 'basic') {
    const enc = Buffer.from(`${o.clientId || ''}:${o.clientSecret || ''}`, 'utf8').toString('base64');
    headers.push({ key: 'Authorization', value: `Basic ${enc}`, enabled: true });
  } else {
    if (o.clientId) form.set('client_id', o.clientId);
    if (o.clientSecret) form.set('client_secret', o.clientSecret);
  }

  const res = await sendRequest({
    method: 'POST',
    url: o.accessTokenUrl,
    headers,
    params: [],
    body: { mode: 'raw', raw: form.toString() },
  });

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
  return { ok: true, accessToken, raw: parsed, status: res.status };
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

function performWithRedirects(request, redirectCount, chain, jarRef) {
  return new Promise((resolve, reject) => {
    const auth = applyAuth(request.auth);

    let url;
    try {
      url = buildUrl(request.url, request.params, auth.query);
    } catch (e) {
      reject(new Error(`Invalid URL: ${request.url}`));
      return;
    }

    const headers = buildHeaders(request.headers, auth.headers);
    const bodyBuffer = buildBody(request.body, headers);

    if (bodyBuffer) headers['Content-Length'] = Buffer.byteLength(bodyBuffer);
    ensureHeader(headers, 'Accept-Encoding', 'gzip, deflate, br');

    // Attach cookies from the jar (unless the request already sets Cookie).
    if (jarRef && jarRef.jar) {
      const cookieHeader = cookieHeaderFor(jarRef.jar, url.toString());
      if (cookieHeader && !Object.keys(headers).some((k) => k.toLowerCase() === 'cookie')) {
        headers['Cookie'] = cookieHeader;
      }
    }

    const transport = url.protocol === 'http:' ? http : https;
    const options = {
      method: (request.method || 'GET').toUpperCase(),
      hostname: url.hostname,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: url.pathname + url.search,
      headers,
    };

    const req = transport.request(options, (res) => {
      if (
        [301, 302, 303, 307, 308].includes(res.statusCode) &&
        res.headers.location &&
        redirectCount < MAX_REDIRECTS
      ) {
        res.resume();
        const nextUrl = new URL(res.headers.location, url).toString();
        const nextMethod = res.statusCode === 303 ? 'GET' : request.method;
        // Store cookies set on the redirect response before following it.
        if (jarRef && jarRef.jar && res.headers['set-cookie']) {
          jarRef.jar = storeCookies(jarRef.jar, res.headers['set-cookie'], url.toString());
        }
        performWithRedirects(
          { ...request, url: nextUrl, method: nextMethod, params: [], auth: { type: 'none' } },
          redirectCount + 1,
          [...chain, { from: url.toString(), status: res.statusCode, to: nextUrl }],
          jarRef
        ).then(resolve, reject);
        return;
      }

      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let raw = Buffer.concat(chunks);
        raw = decompress(raw, res.headers['content-encoding']);
        const text = raw.toString('utf8');
        // Store any cookies from the final response into the jar.
        if (jarRef && jarRef.jar && res.headers['set-cookie']) {
          jarRef.jar = storeCookies(jarRef.jar, res.headers['set-cookie'], url.toString());
        }
        resolve({
          status: res.statusCode,
          statusText: res.statusMessage || '',
          headers: flattenHeaders(res.headers),
          cookies: parseCookies(res.headers['set-cookie']),
          body: text,
          size: raw.length,
          contentType: res.headers['content-type'] || '',
          finalUrl: url.toString(),
          redirects: chain,
          // Exactly what we sent, for the "Request Sent" diagnostic view.
          // For multipart with files, show a summary instead of raw bytes.
          sent: {
            method: options.method,
            url: url.toString(),
            headers: Object.entries(headers).map(([key, value]) => ({ key, value: String(value) })),
            body: describeSentBody(request.body, bodyBuffer),
          },
        });
      });
    });

    req.on('error', (err) => reject(err));

    const timeout = request.timeout || DEFAULT_TIMEOUT_MS;
    req.setTimeout(timeout, () => {
      req.destroy(new Error(`Request timed out after ${timeout}ms`));
    });

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
