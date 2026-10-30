import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { sendRequest } from '../../packages/core/src/request-engine.js';
import { createSendContext } from '../../packages/core/src/network-runtime.js';
import { normalizeNetworkSettings } from '../../shared/networkSettings.js';

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

const network = (overrides = {}) =>
  normalizeNetworkSettings({ proxyMode: 'none', timeoutMs: 120, ...overrides });

describe('abort and timeout', () => {
  it('stops an in-flight request when aborted', async () => {
    const { port } = await startServer((req, res) => {
      // Never answers: the client must give up on its own.
      setTimeout(() => {
        res.writeHead(200);
        res.end('late');
      }, 60000).unref();
    });

    const request = { method: 'GET', url: `http://127.0.0.1:${port}/slow`, settings: {} };
    const ctx = createSendContext({ network: network({ timeoutMs: 60000 }), request });
    try {
      const promise = sendRequest(request, ctx.options);
      setTimeout(() => ctx.abort(new Error('Request aborted')), 50);

      const res = await promise;
      expect(res.ok).toBe(false);
      expect(res.error).toBe('Request aborted');
      expect(res.code).toBe('ABORT_ERR');
      expect(res.timeMs).toBeLessThan(1000);
    } finally {
      ctx.cleanup();
    }
  });

  it('times out using the request-level override', async () => {
    const { port } = await startServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200);
        res.end('late');
      }, 60000).unref();
    });

    const request = {
      method: 'GET',
      url: `http://127.0.0.1:${port}/slow`,
      settings: { timeoutMs: 100 },
    };
    const ctx = createSendContext({ network: network({ timeoutMs: 60000 }), request });
    try {
      const res = await sendRequest(request, ctx.options);
      expect(res.ok).toBe(false);
      expect(res.error).toBe('Request timed out after 100ms');
      expect(res.code).toBe('ETIMEDOUT');
    } finally {
      ctx.cleanup();
    }
  });

  it('does not start a request when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Request aborted'));

    const res = await sendRequest(
      { method: 'GET', url: 'http://127.0.0.1:1/none' },
      { signal: controller.signal }
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe('ABORT_ERR');
    expect(res.timeMs).toBeLessThan(1000);
  });
});
