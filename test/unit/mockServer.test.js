import { afterAll, describe, expect, it } from 'vitest';
import { startMockServer } from '../../electron/mock-server.js';

// Inline collection: one folder with a parameterized request + an example,
// one request without an example, and a root route.
const collections = [
  {
    id: 'col_mock',
    name: 'Mock API',
    items: [
      {
        id: 'fld_users',
        type: 'folder',
        name: 'Users',
        items: [
          {
            id: 'req_get_user',
            type: 'request',
            name: 'Get user',
            method: 'GET',
            url: 'https://api.example.com/users/:id',
            examples: [
              {
                id: 'ex_get_user',
                name: 'Created user',
                savedAt: '2024-01-01T00:00:00.000Z',
                request: { method: 'GET', url: 'https://api.example.com/users/:id' },
                response: {
                  status: 201,
                  statusText: 'Created',
                  headers: [{ key: 'X-Mock', value: 'yes', enabled: true }],
                  body: '{"id":42}',
                  contentType: 'application/json',
                },
              },
            ],
          },
          {
            id: 'req_create_user',
            type: 'request',
            name: 'Create user',
            method: 'POST',
            url: 'https://api.example.com/users',
            examples: [],
          },
        ],
      },
      {
        id: 'req_root',
        type: 'request',
        name: 'Root',
        method: 'GET',
        url: 'https://api.example.com/',
        examples: [
          {
            id: 'ex_root',
            savedAt: '2024-01-01T00:00:00.000Z',
            response: { status: 200, statusText: 'OK', headers: [], body: 'root', contentType: 'text/plain' },
          },
        ],
      },
    ],
  },
];

const started = [];

async function startMock(options = {}) {
  const server = await startMockServer({ collections, ...options });
  started.push(server);
  return server;
}

afterAll(async () => {
  for (const server of started) {
    try {
      await server.stop();
    } catch {
      /* best effort */
    }
  }
});

describe('startMockServer', () => {
  it('registers one route per request, flattening folders', async () => {
    const server = await startMock({
      // The callback is exercised below; this server only needs the routes.
    });
    expect(server.ok).toBe(true);
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
    expect(server.routes).toEqual([
      { method: 'GET', path: '/users/:id' },
      { method: 'POST', path: '/users' },
      { method: 'GET', path: '/' },
    ]);
  });

  it('serves the newest example for a matched route, with pseudo-segment matching', async () => {
    const server = await startMock();
    const res = await fetch(`${server.url}/users/42?active=1`, {
      headers: { Accept: 'application/json' },
    });

    expect(res.status).toBe(201);
    expect(await res.text()).toBe('{"id":42}');
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('x-mock')).toBe('yes');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('answers 501 JSON for a route with no examples', async () => {
    const server = await startMock();
    const res = await fetch(`${server.url}/users`, { method: 'POST' });

    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body).toEqual({
      error: 'No saved example for this route',
      method: 'POST',
      path: '/users',
    });
  });

  it('answers 404 with the registered route list for unknown routes', async () => {
    const server = await startMock();
    const res = await fetch(`${server.url}/does/not/exist`);

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('No mock route matched');
    expect(body.method).toBe('GET');
    expect(body.path).toBe('/does/not/exist');
    expect(body.routes).toEqual([
      { method: 'GET', path: '/users/:id' },
      { method: 'POST', path: '/users' },
      { method: 'GET', path: '/' },
    ]);
  });

  it('answers CORS preflight with 204 and permissive headers', async () => {
    const server = await startMock();
    const res = await fetch(`${server.url}/users/42`, { method: 'OPTIONS' });

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toBe('*');
  });

  it('honours delayMs before responding', async () => {
    const server = await startMock({ delayMs: 120 });
    const startedAt = performance.now();
    const res = await fetch(`${server.url}/users/42`);
    const elapsed = performance.now() - startedAt;

    expect(res.status).toBe(201);
    await res.text();
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });

  it('ignores delays outside the 0..10000ms range (does not throw)', async () => {
    const server = await startMock({ delayMs: -50 });
    const res = await fetch(`${server.url}/`);
    expect(res.status).toBe(200);
    await res.text();
  });

  it('records logs and calls onLog without headers or bodies', async () => {
    const seen = [];
    const server = await startMock({ onLog: (entry) => seen.push(entry) });

    await fetch(`${server.url}/users/42`);
    await fetch(`${server.url}/nope`);

    const logs = server.getLogs();
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ method: 'GET', path: '/users/42', status: 201 });
    expect(logs[1]).toMatchObject({ method: 'GET', path: '/nope', status: 404 });
    expect(typeof logs[0].at).toBe('number');
    expect(typeof logs[0].ms).toBe('number');
    expect(Object.keys(logs[0]).sort()).toEqual(['at', 'method', 'ms', 'path', 'status']);
    expect(seen).toHaveLength(2);
    expect(seen[1].status).toBe(404);
  });

  it('caps the log ring buffer at 200 entries', async () => {
    const server = await startMock();

    for (let i = 0; i < 205; i += 1) {
      const res = await fetch(`${server.url}/`);
      await res.text();
    }

    const logs = server.getLogs();
    expect(logs).toHaveLength(200);
    // Oldest entries fall off first; the last request is still present.
    expect(logs[logs.length - 1]).toMatchObject({ path: '/', status: 200 });
  });

  it('stops the server and tolerates a second stop()', async () => {
    const server = await startMock();
    expect(server.ok).toBe(true);
    const url = server.url;

    const ok = await fetch(`${url}/`);
    await ok.text();

    await server.stop();
    await expect(fetch(`${url}/`)).rejects.toThrow();
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it('returns an error object when the port is already in use', async () => {
    const first = await startMock();
    const second = await startMockServer({ collections, port: first.port });

    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/EADDRINUSE/);
    await second.stop();
  });
});
