import { afterAll, describe, expect, it } from 'vitest';
import { startMockServer } from '../../electron/mock-server.js';

function scenarioCollection() {
  return [
    {
      id: 'col_scenarios',
      items: [
        {
          id: 'req_orders',
          type: 'request',
          name: 'Order',
          method: 'GET',
          url: 'https://api.test/orders/:id',
          examples: [
            {
              id: 'ex_orders',
              response: { status: 200, headers: [], body: 'example', contentType: 'text/plain' },
            },
          ],
          mock: {
            mode: 'auto',
            scenarios: [
              {
                id: 'ok',
                name: 'OK',
                status: 200,
                headers: [{ key: 'X-Scenario', value: 'ok', enabled: true }],
                contentType: 'application/json',
                body: '{"id":"{{request.path.id}}"}',
                conditions: [
                  { source: 'query', key: 'state', operator: 'equals', value: 'ok' },
                ],
              },
              {
                id: 'down',
                name: 'Down',
                status: 503,
                contentType: 'application/json',
                body: '{"error":"down"}',
                isDefault: true,
              },
              {
                id: 'missing',
                name: 'Missing',
                status: 404,
                contentType: 'application/json',
                body: '{"error":"missing"}',
              },
            ],
          },
        },
        {
          id: 'req_special',
          type: 'request',
          name: 'Special',
          method: 'GET',
          url: 'https://api.test/orders/special',
          mock: {
            scenarios: [
              {
                id: 'special',
                name: 'Special',
                status: 200,
                body: 'special',
                contentType: 'text/plain',
                isDefault: true,
              },
            ],
          },
        },
        {
          id: 'req_echo',
          type: 'request',
          name: 'Echo',
          method: 'POST',
          url: 'https://api.test/echo',
          mock: {
            scenarios: [
              {
                id: 'admin',
                name: 'Admin',
                status: 200,
                contentType: 'application/json',
                body: '{"role":"admin","id":"{{request.body.user.id}}"}',
                conditions: [
                  { source: 'body', key: 'user.role', operator: 'equals', value: 'admin' },
                ],
              },
            ],
          },
        },
      ],
    },
  ];
}

const started = [];

async function start(overrides = {}) {
  const server = await startMockServer({
    collections: scenarioCollection(),
    ...overrides,
  });
  started.push(server);
  return server;
}

afterAll(async () => {
  for (const server of started) await server.stop().catch(() => {});
});

describe('mock scenarios runtime', () => {
  it('selects a condition match, templates the body, and logs the scenario', async () => {
    const server = await start();
    const res = await fetch(`${server.url}/orders/42?state=ok`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"id":"42"}');
    expect(res.headers.get('x-scenario')).toBe('ok');

    const log = server.getLogs().at(-1);
    expect(log).toMatchObject({
      path: '/orders/42',
      status: 200,
      scenarioId: 'ok',
      scenarioName: 'OK',
      matched: true,
    });
  });

  it('falls back to the default scenario, then to an example', async () => {
    const server = await start();
    const fallback = await fetch(`${server.url}/orders/42`);
    expect(fallback.status).toBe(503);
    expect(await fallback.text()).toBe('{"error":"down"}');

    const exampleServer = await startMockServer({
      collections: [
        {
          items: [
            {
              id: 'req_plain',
              method: 'GET',
              url: '/plain',
              examples: [{ response: { status: 202, body: 'plain', contentType: 'text/plain' } }],
              mock: { scenarios: [{ id: 'off', enabled: false, isDefault: true, body: 'x' }] },
            },
          ],
        },
      ],
    });
    started.push(exampleServer);
    const example = await fetch(`${exampleServer.url}/plain`);
    expect(example.status).toBe(202);
    expect(await example.text()).toBe('plain');
  });

  it('supports a runtime manual selection and clearing it', async () => {
    const server = await start();
    expect(server.selectScenario('req_orders', 'missing')).toBe(true);
    const missing = await fetch(`${server.url}/orders/42?state=ok`);
    expect(missing.status).toBe(404);

    expect(server.selectScenario('req_orders', null)).toBe(true);
    const auto = await fetch(`${server.url}/orders/42?state=ok`);
    expect(auto.status).toBe(200);

    expect(server.selectScenario('nope', 'missing')).toBe(false);
    expect(server.selectScenario('req_orders', 'nope')).toBe(false);
  });

  it('prefers an exact route over a parameter route', async () => {
    const server = await start();
    const res = await fetch(`${server.url}/orders/special`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('special');
  });

  it('parses JSON bodies for body conditions and templates', async () => {
    const server = await start();
    const res = await fetch(`${server.url}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: { role: 'admin', id: 7 } }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"role":"admin","id":"7"}');

    const denied = await fetch(`${server.url}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: { role: 'user', id: 7 } }),
    });
    expect(denied.status).toBe(501);
  });

  it('reloads routes without changing the port and keeps logs', async () => {
    const server = await start();
    await fetch(`${server.url}/orders/42`);
    expect(server.getLogs()).toHaveLength(1);

    const next = scenarioCollection();
    next[0].items[0].mock.scenarios[1].body = '{"error":"new"}';
    const details = server.setRoutes(next);
    expect(server.port).toBe(server.port);
    const res = await fetch(`${server.url}/orders/42`);
    expect(await res.text()).toBe('{"error":"new"}');
    expect(server.getLogs()).toHaveLength(2);
    expect(details.find((r) => r.requestId === 'req_orders').scenarioCount).toBe(3);
  });

  it('omits disabled requests from the route list', async () => {
    const collections = scenarioCollection();
    collections[0].items[0].mock.enabled = false;
    const server = await startMockServer({ collections });
    started.push(server);
    expect(server.routes.map((r) => r.path)).not.toContain('/orders/:id');
    const res = await fetch(`${server.url}/orders/42`);
    expect(res.status).toBe(404);
  });
});
