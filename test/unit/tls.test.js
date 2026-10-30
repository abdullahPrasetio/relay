import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sendRequest } from '../../packages/core/src/request-engine.js';
import { createSendContext } from '../../packages/core/src/network-runtime.js';
import { normalizeNetworkSettings } from '../../shared/networkSettings.js';

const tlsDir = path.join(import.meta.dirname, '..', 'fixtures', 'tls');
const pem = (name) => readFileSync(path.join(tlsDir, name));

const servers = [];

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function startHttps(tlsOptions) {
  const server = https.createServer(tlsOptions, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  servers.push(server);
  await listen(server);
  return { server, port: server.address().port };
}

function startHttp(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  return listen(server).then(() => ({ server, port: server.address().port }));
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

const network = (overrides = {}) =>
  normalizeNetworkSettings({
    proxyMode: 'none',
    timeoutMs: 5000,
    ...overrides,
  });

async function send(url, settings, netOverrides = {}) {
  const ctx = createSendContext({
    network: network(netOverrides),
    request: { method: 'GET', url, headers: [], params: [], settings },
  });
  try {
    return await sendRequest({ method: 'GET', url, headers: [], params: [] }, ctx.options);
  } finally {
    ctx.cleanup();
  }
}

describe('TLS handling', () => {
  it('fails verification against a self-signed certificate by default', async () => {
    const { port } = await startHttps({
      key: pem('self-key.pem'),
      cert: pem('self-cert.pem'),
    });

    const res = await send(`https://localhost:${port}/`, {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/certificate|self-signed/i);
  });

  it('accepts a self-signed certificate when verification is off for the request', async () => {
    const { port } = await startHttps({
      key: pem('self-key.pem'),
      cert: pem('self-cert.pem'),
    });

    const res = await send(`https://localhost:${port}/`, { verifyTls: false });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.body).toBe('ok');
    expect(res.tlsInsecure).toBe(true);
  });

  it('trusts a CA-signed server when the custom CA is configured', async () => {
    const { port } = await startHttps({
      key: pem('server-key.pem'),
      cert: pem('server-cert.pem'),
    });

    const res = await send(`https://localhost:${port}/`, {}, {
      customCaPath: path.join(tlsDir, 'ca-cert.pem'),
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.tlsInsecure).toBe(false);
  });

  it('presents a client certificate for mTLS', async () => {
    const { port } = await startHttps({
      key: pem('server-key.pem'),
      cert: pem('server-cert.pem'),
      ca: pem('ca-cert.pem'),
      requestCert: true,
      rejectUnauthorized: true,
    });

    const res = await send(`https://localhost:${port}/`, {}, {
      customCaPath: path.join(tlsDir, 'ca-cert.pem'),
      clientCertPath: path.join(tlsDir, 'client-cert.pem'),
      clientKeyPath: path.join(tlsDir, 'client-key.pem'),
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
  });

  it('reports a missing TLS file instead of sending', async () => {
    expect(() =>
      createSendContext({
        network: network({ customCaPath: path.join(tlsDir, 'nope.pem') }),
        request: { method: 'GET', url: 'https://localhost:1/', settings: {} },
      })
    ).toThrow(/Cannot read TLS file/);
  });

  it('verifies the certificate against the configured SNI name', async () => {
    const { port } = await startHttps({
      key: pem('server-key.pem'),
      cert: pem('server-cert.pem'), // valid for localhost only
    });
    const caPath = path.join(tlsDir, 'ca-cert.pem');

    // Connecting by IP while asserting the name the certificate carries.
    const named = await send(`https://127.0.0.1:${port}/`, {}, {
      customCaPath: caPath,
      servername: 'localhost',
    });
    expect(named.ok).toBe(true);
    expect(named.status).toBe(200);

    const wrongName = await send(`https://127.0.0.1:${port}/`, {}, {
      customCaPath: caPath,
      servername: 'wrong.example',
    });
    expect(wrongName.ok).toBe(false);
    expect(wrongName.error).toMatch(/altnames|hostname|certificate/i);
  });
});

describe('redirect policy', () => {
  it('follows redirects by default', async () => {
    const { port } = await startHttp((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { Location: '/end' });
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('arrived');
      }
    });

    const res = await send(`http://127.0.0.1:${port}/start`, {});
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.body).toBe('arrived');
    expect(res.redirects).toHaveLength(1);
  });

  it('returns the 3xx response when following is disabled', async () => {
    const { port } = await startHttp((req, res) => {
      res.writeHead(302, { Location: '/end' });
      res.end();
    });

    const res = await send(`http://127.0.0.1:${port}/start`, { followRedirects: false });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(302);
    expect(res.redirects).toHaveLength(0);
  });

  it('stops at the request-level redirect cap', async () => {
    const { port } = await startHttp((req, res) => {
      const n = Number(new URL(req.url, 'http://x').searchParams.get('n') || 0);
      res.writeHead(302, { Location: `/?n=${n + 1}` });
      res.end();
    });

    const res = await send(`http://127.0.0.1:${port}/?n=0`, { maxRedirects: 2 });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(302);
    expect(res.redirects).toHaveLength(2);
  });
});
