import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isTextualContentType,
  parseCharset,
  sendRequest,
} from '../../packages/core/src/request-engine.js';

const pngBytes = readFileSync(
  path.join(import.meta.dirname, '..', 'fixtures', 'binary', 'pixel.png')
);
const tlsDir = path.join(import.meta.dirname, '..', 'fixtures', 'tls');
const pem = (name) => readFileSync(path.join(tlsDir, name));

const servers = [];

function startServer(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  }).then(() => ({ server, port: server.address().port }));
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function get(url, options = {}) {
  return sendRequest({ method: 'GET', url, headers: [], params: [] }, options);
}

function startHttps(handler, tls) {
  const server = https.createServer(tls, handler);
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  }).then(() => ({ server, port: server.address().port }));
}

describe('request timings', () => {
  it('reports connection timings for a plain HTTP response', async () => {
    const { port } = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('timed');
    });

    const res = await get(`http://127.0.0.1:${port}/`);
    expect(res.ok).toBe(true);
    expect(res.timings).toBeTruthy();

    const t = res.timings;
    expect(typeof t.startMs).toBe('number');
    expect(typeof t.connectMs).toBe('number');
    expect(t.connectMs).toBeGreaterThanOrEqual(0);
    expect(typeof t.ttfbMs).toBe('number');
    expect(t.ttfbMs).toBeGreaterThanOrEqual(0);
    expect(t.totalMs).toBeGreaterThanOrEqual(t.ttfbMs);
    // Plain HTTP never performs a TLS handshake.
    expect(t.tlsMs).toBeNull();
    // DNS is only observable when the lookup event fires (IPs may skip it).
    expect(t.dnsMs === null || typeof t.dnsMs === 'number').toBe(true);
  });

  it('reports a TLS timing for an HTTPS response', async () => {
    const { port } = await startHttps(
      (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('secure');
      },
      { key: pem('self-key.pem'), cert: pem('self-cert.pem') }
    );

    const res = await get(`https://127.0.0.1:${port}/`, {
      tls: { rejectUnauthorized: false },
    });
    expect(res.ok).toBe(true);
    expect(res.body).toBe('secure');

    const t = res.timings;
    expect(typeof t.connectMs).toBe('number');
    expect(typeof t.tlsMs).toBe('number');
    expect(t.tlsMs).toBeGreaterThanOrEqual(0);
    expect(t.totalMs).toBeGreaterThanOrEqual(t.ttfbMs);
  });
});

describe('charset and content-type helpers', () => {
  it('parses charsets and rejects unsupported encodings', () => {
    expect(parseCharset('application/json; charset=utf-8')).toBe('utf-8');
    expect(parseCharset('text/plain; charset="ISO-8859-1"')).toBe('latin1');
    expect(parseCharset('text/plain; charset=x-bogus')).toBe('utf8');
    expect(parseCharset('')).toBe('utf8');
    expect(parseCharset(undefined)).toBe('utf8');
  });

  it('classifies textual content types', () => {
    for (const ct of [
      'text/plain',
      'text/html; charset=utf-8',
      'application/json',
      'application/xml',
      'application/javascript',
      'application/problem+json',
      'application/vnd.api+json',
      'image/svg+xml',
    ]) {
      expect(isTextualContentType(ct)).toBe(true);
    }
    for (const ct of ['image/png', 'application/pdf', 'application/octet-stream']) {
      expect(isTextualContentType(ct)).toBe(false);
    }
    // Missing type: caller falls back to UTF-8 validity.
    expect(isTextualContentType('')).toBe(true);
  });
});

describe('response body decoding', () => {
  it('flags binary image bodies and keeps exact bytes as base64', async () => {
    const { port } = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(pngBytes);
    });

    const res = await get(`http://127.0.0.1:${port}/pixel.png`);
    expect(res.ok).toBe(true);
    expect(res.isBinary).toBe(true);
    expect(res.body).toBe('');
    expect(Buffer.from(res.bodyBase64, 'base64').equals(pngBytes)).toBe(true);
    expect(res.size).toBe(pngBytes.length);
  });

  it('keeps text bodies as text', async () => {
    const { port } = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('hello');
    });

    const res = await get(`http://127.0.0.1:${port}/`);
    expect(res.isBinary).toBe(false);
    expect(res.body).toBe('hello');
    expect(res.bodyBase64).toBe('');
    expect(res.charset).toBe('utf8');
  });

  it('trusts valid UTF-8 when no content type is sent', async () => {
    const { port } = await startServer((req, res) => {
      res.writeHead(200);
      res.end('plain words');
    });

    const res = await get(`http://127.0.0.1:${port}/`);
    expect(res.isBinary).toBe(false);
    expect(res.body).toBe('plain words');
  });

  it('treats a missing content type with invalid UTF-8 as binary', async () => {
    const { port } = await startServer((req, res) => {
      res.writeHead(200);
      res.end(Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    });

    const res = await get(`http://127.0.0.1:${port}/`);
    expect(res.isBinary).toBe(true);
    expect(res.body).toBe('');
    expect(Buffer.from(res.bodyBase64, 'base64').length).toBe(4);
  });

  it('reports the declared charset', async () => {
    const { port } = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end('{"ok":true}');
    });

    const res = await get(`http://127.0.0.1:${port}/`);
    expect(res.isBinary).toBe(false);
    expect(res.body).toBe('{"ok":true}');
    expect(res.charset).toBe('utf-8');
  });

  it('keeps an empty body textual', async () => {
    const { port } = await startServer((req, res) => {
      res.writeHead(204);
      res.end();
    });

    const res = await get(`http://127.0.0.1:${port}/`);
    expect(res.ok).toBe(true);
    expect(res.isBinary).toBe(false);
    expect(res.body).toBe('');
    expect(res.bodyBase64).toBe('');
    expect(res.size).toBe(0);
  });

  it('fails instead of truncating when the body exceeds the cap', async () => {
    const { port } = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('x'.repeat(2048));
    });

    const res = await get(`http://127.0.0.1:${port}/`, { maxResponseBytes: 1024 });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Response exceeds');
  });
});

describe('cookie jar policy', () => {
  const jar = [
    {
      name: 'sid',
      value: 'abc',
      domain: '127.0.0.1',
      path: '/',
      expires: null,
      secure: false,
      httpOnly: false,
    },
  ];

  it('sends and updates jar cookies by default', async () => {
    let seenCookie = null;
    const { port } = await startServer((req, res) => {
      seenCookie = req.headers.cookie || '';
      res.writeHead(200, { 'Set-Cookie': 'fresh=1', 'Content-Type': 'text/plain' });
      res.end('ok');
    });

    const res = await get(`http://127.0.0.1:${port}/`, { cookieJar: jar });

    expect(seenCookie).toBe('sid=abc');
    expect(res.cookieJar.map((c) => c.name)).toEqual(['sid', 'fresh']);
  });

  it('neither sends nor stores cookies when the request opts out', async () => {
    let seenCookie = null;
    const { port } = await startServer((req, res) => {
      seenCookie = req.headers.cookie || '';
      res.writeHead(200, { 'Set-Cookie': 'fresh=1', 'Content-Type': 'text/plain' });
      res.end('ok');
    });

    const res = await get(`http://127.0.0.1:${port}/`, {
      cookieJar: jar,
      useCookieJar: false,
    });

    expect(seenCookie).toBe('');
    expect(res.cookieJar.map((c) => c.name)).toEqual(['sid']);
  });
});
