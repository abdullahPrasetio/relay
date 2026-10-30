import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { createChangeStream } from '../../electron/cloud/sse.js';

const servers = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          try {
            server.closeAllConnections?.();
          } catch {
            /* already closed */
          }
          server.close(() => resolve());
        })
    )
  );
});

function startServer(handler) {
  return new Promise((resolve, reject) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push(req);
      req.on('error', () => {});
      res.on('error', () => {});
      try {
        handler(req, res, requests.length - 1);
      } catch {
        try {
          res.destroy();
        } catch {
          /* ignore */
        }
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      servers.push(server);
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
      });
    });
  });
}

function sseHeaders(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeout = 3000, interval = 10 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return;
    await sleep(interval);
  }
  throw new Error('timed out waiting for condition');
}

describe('createChangeStream', () => {
  it('streams seq events with a bearer token and the stream accept header', async () => {
    const { url, requests } = await startServer((req, res) => {
      sseHeaders(res);
      res.write(': ready\n\n');
      res.write('id: 1\ndata: {"seq":1}\n\n');
      res.write('id: 2\ndata: {"seq":2,"workspaceId":"ws-1"}\n\n');
    });

    const events = [];
    const statuses = [];
    let providerCalls = 0;
    const stream = createChangeStream({
      baseUrl: url,
      tokenProvider: async (workspaceId) => {
        providerCalls += 1;
        expect(workspaceId).toBe('ws-1');
        return 'test-token';
      },
      reconnect: { initialDelayMs: 20, maxDelayMs: 50 },
    });

    stream.start('ws-1', (event) => events.push(event), (status) => statuses.push(status));
    try {
      await waitFor(() => events.length === 2);
      expect(events.map((event) => event.seq)).toEqual([1, 2]);
      expect(providerCalls).toBe(1);
      expect(statuses[0].state).toBe('connecting');
      expect(statuses).toContainEqual(expect.objectContaining({ state: 'open' }));

      const req = requests[0];
      expect(req.url).toBe('/api/v1/workspaces/ws-1/stream');
      expect(req.headers.authorization).toBe('Bearer test-token');
      expect(req.headers.accept).toBe('text/event-stream');
    } finally {
      stream.stop();
    }
  });

  it('accepts a base url that already includes the api prefix', async () => {
    const { url, requests } = await startServer((req, res) => {
      sseHeaders(res);
      res.write('data: {"seq":3}\n\n');
    });

    const events = [];
    const stream = createChangeStream({
      baseUrl: `${url}/api/v1`,
      tokenProvider: () => 'token',
      reconnect: { initialDelayMs: 10, maxDelayMs: 20 },
    });
    stream.start('ws/encoded', (event) => events.push(event));
    try {
      await waitFor(() => events.length === 1);
      expect(requests[0].url).toBe('/api/v1/workspaces/ws%2Fencoded/stream');
    } finally {
      stream.stop();
    }
  });

  it('ignores heartbeat comments', async () => {
    const events = [];
    const { url } = await startServer((req, res) => {
      sseHeaders(res);
      res.write(': ping\n\n');
      res.write(': keep-alive\n\n');
      res.write('id: 7\ndata: {"seq":7}\n\n');
      res.write(': ping\n\n');
    });

    const stream = createChangeStream({
      baseUrl: url,
      tokenProvider: () => 'token',
      reconnect: { initialDelayMs: 10, maxDelayMs: 20 },
    });
    stream.start('ws-1', (event) => events.push(event));
    try {
      await waitFor(() => events.length === 1);
      await sleep(100);
      expect(events).toEqual([{ seq: 7, data: '{"seq":7}' }]);
    } finally {
      stream.stop();
    }
  });

  it('reconnects after the server ends the connection and resumes the last id', async () => {
    const { url, requests } = await startServer((req, res, index) => {
      sseHeaders(res);
      if (index === 0) {
        res.write('id: 1\ndata: {"seq":1}\n\n');
        setTimeout(() => res.end(), 10);
        return;
      }
      res.write('id: 2\ndata: {"seq":2}\n\n');
    });

    const events = [];
    const statuses = [];
    const stream = createChangeStream({
      baseUrl: url,
      tokenProvider: () => 'token',
      reconnect: { initialDelayMs: 20, maxDelayMs: 80, jitter: (delay) => delay },
    });
    stream.start(
      'ws-1',
      (event) => events.push(event),
      (status) => statuses.push(status)
    );
    try {
      await waitFor(() => events.length === 2);
      expect(events.map((event) => event.seq)).toEqual([1, 2]);
      expect(requests.length).toBeGreaterThanOrEqual(2);
      expect(statuses).toContainEqual(
        expect.objectContaining({ state: 'reconnecting', reason: 'eof' })
      );
      expect(requests[1].headers['last-event-id']).toBe('1');
    } finally {
      stream.stop();
    }
  });

  it('retries non-2xx responses with backoff', async () => {
    const { url, requests } = await startServer((req, res, index) => {
      if (index === 0) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"status":false,"code":"unavailable"}');
        return;
      }
      sseHeaders(res);
      res.write('data: {"seq":9}\n\n');
    });

    const events = [];
    const statuses = [];
    const stream = createChangeStream({
      baseUrl: url,
      tokenProvider: () => 'token',
      reconnect: { initialDelayMs: 15, maxDelayMs: 60, jitter: (delay) => delay },
    });
    stream.start(
      'ws-1',
      (event) => events.push(event),
      (status) => statuses.push(status)
    );
    try {
      await waitFor(() => events.length === 1);
      expect(requests.length).toBeGreaterThanOrEqual(2);
      expect(statuses).toContainEqual(
        expect.objectContaining({ state: 'reconnecting', reason: 'http', httpStatus: 503 })
      );
    } finally {
      stream.stop();
    }
  });

  it('stops idempotently and never fetches again', async () => {
    const { url } = await startServer((req, res) => {
      sseHeaders(res);
      res.write(': open\n\n');
    });

    let fetchCalls = 0;
    const statuses = [];
    const stream = createChangeStream({
      baseUrl: url,
      tokenProvider: () => 'token',
      fetchImpl: (...args) => {
        fetchCalls += 1;
        return fetch(...args);
      },
      reconnect: { initialDelayMs: 10, maxDelayMs: 20 },
    });

    stream.start('ws-1', () => {}, (status) => statuses.push(status));
    await waitFor(() => fetchCalls === 1);
    stream.stop();
    stream.stop();
    await sleep(150);
    expect(fetchCalls).toBe(1);
    expect(statuses.at(-1)).toEqual({ state: 'closed' });
  });

  it('cancels a reconnect that was already scheduled', async () => {
    const { url } = await startServer((req, res) => {
      // Drop immediately so a retry is queued.
      res.destroy();
    });

    let fetchCalls = 0;
    const stream = createChangeStream({
      baseUrl: url,
      tokenProvider: () => 'token',
      fetchImpl: (...args) => {
        fetchCalls += 1;
        return fetch(...args);
      },
      reconnect: { initialDelayMs: 50, maxDelayMs: 100 },
    });

    stream.start('ws-1', () => {});
    await waitFor(() => fetchCalls === 1);
    stream.stop();
    await sleep(200);
    expect(fetchCalls).toBe(1);
  });

  it('does not log or expose the access token', async () => {
    const { url } = await startServer((req, res) => {
      sseHeaders(res);
      res.write('data: {"seq":1}\n\n');
    });

    const logs = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
      logs.push([method, console[method]]);
      console[method] = (...args) => logs.push([method, args]);
    }

    const events = [];
    const stream = createChangeStream({
      baseUrl: url,
      tokenProvider: () => 'super-secret-token',
      reconnect: { initialDelayMs: 10, maxDelayMs: 20 },
    });
    stream.start('ws-1', (event) => events.push(event));
    try {
      await waitFor(() => events.length === 1);
      const printed = logs
        .filter(([, args]) => Array.isArray(args))
        .flatMap(([, args]) => args.map((value) => String(value)))
        .join(' ');
      expect(printed).not.toContain('super-secret-token');
    } finally {
      stream.stop();
      for (const [method, original] of logs) console[method] = original;
    }
  });

  it('validates its inputs', () => {
    expect(() => createChangeStream({})).toThrow(/tokenProvider/);
    const stream = createChangeStream({ tokenProvider: () => 'x' });
    expect(() => stream.start('', () => {})).toThrow(/workspaceId/);
    expect(() => stream.stop()).not.toThrow();
  });
});
