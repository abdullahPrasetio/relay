import crypto from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { startMockServer } from '../../electron/mock-server.js';

const TOKEN = 'relay_mock_test_token';
const TOKEN_HASH = crypto.createHash('sha256').update(TOKEN, 'utf8').digest('hex');

function scenario(id, extra = {}) {
  return {
    id,
    name: id,
    enabled: true,
    status: 200,
    statusText: 'OK',
    headers: [],
    contentType: 'application/json',
    body: '{"scenario":"' + id + '"}',
    delayMs: 0,
    isDefault: false,
    conditions: [],
    ...extra,
  };
}

const collections = [
  {
    id: 'col_mode',
    name: 'Mode',
    items: [
      {
        id: 'req_orders',
        type: 'request',
        name: 'Orders',
        method: 'GET',
        url: 'https://api.example.com/orders/:id',
        examples: [],
        mock: {
          enabled: true,
          mode: 'auto',
          activeScenarioId: null,
          scenarios: [
            scenario('ok', {
              status: 200,
              body: '{"id":"{{request.path.id}}"}',
              conditions: [{ source: 'query', key: 'state', operator: 'equals', value: 'ok' }],
            }),
            scenario('down', {
              status: 503,
              isDefault: true,
              body: '{"error":"down"}',
            }),
            scenario('off', { enabled: false, status: 418, body: '{"teapot":true}' }),
          ],
        },
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

describe('mock server binding and token', () => {
  it('stays open on loopback when no token is configured', async () => {
    const server = await startMock();
    expect(server.tokenRequired).toBe(false);
    expect(server.host).toBe('127.0.0.1');

    const res = await fetch(`${server.url}/orders/1`);
    expect(res.status).toBe(503);
  });

  it('requires the token on every real request in server mode', async () => {
    const server = await startMock({ tokenHash: TOKEN_HASH });
    expect(server.tokenRequired).toBe(true);

    const anonymous = await fetch(`${server.url}/orders/1`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toContain('Relay mock');
    expect(await anonymous.json()).toMatchObject({ error: 'Unauthorized' });

    const wrong = await fetch(`${server.url}/orders/1`, {
      headers: { Authorization: 'Bearer nope' },
    });
    expect(wrong.status).toBe(401);

    const bearer = await fetch(`${server.url}/orders/1`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(bearer.status).toBe(503);

    const custom = await fetch(`${server.url}/orders/1`, {
      headers: { 'x-relay-mock-token': TOKEN },
    });
    expect(custom.status).toBe(503);

    const query = await fetch(`${server.url}/orders/1?__token=${TOKEN}`);
    expect(query.status).toBe(503);
  });

  it('answers CORS preflight without a token', async () => {
    const server = await startMock({ tokenHash: TOKEN_HASH });
    const res = await fetch(`${server.url}/orders/1`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.example',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('ignores a malformed token hash instead of locking the server', async () => {
    const server = await startMock({ tokenHash: 'not-a-digest' });
    expect(server.tokenRequired).toBe(false);
    expect((await fetch(`${server.url}/orders/1`)).status).toBe(503);
  });
});

describe('per-call scenario override', () => {
  it('serves automatic matching when nothing forces a scenario', async () => {
    const server = await startMock();
    expect((await fetch(`${server.url}/orders/1`)).status).toBe(503);
    const matched = await fetch(`${server.url}/orders/1?state=ok`);
    expect(matched.status).toBe(200);
    expect(await matched.text()).toBe('{"id":"1"}');
  });

  it('forces a scenario with ?__scenario=', async () => {
    const server = await startMock();
    const forced = await fetch(`${server.url}/orders/1?state=ok&__scenario=down`);
    expect(forced.status).toBe(503);
    expect(await forced.text()).toBe('{"error":"down"}');
  });

  it('ignores an unknown or disabled scenario id', async () => {
    const server = await startMock();
    const unknown = await fetch(`${server.url}/orders/1?state=ok&__scenario=missing`);
    expect(unknown.status).toBe(200);

    // `off` exists but is disabled, so it must not be reachable by query.
    const disabled = await fetch(`${server.url}/orders/1?state=ok&__scenario=off`);
    expect(disabled.status).toBe(200);
    expect(await disabled.text()).toBe('{"id":"1"}');
  });

  it('wins over the runtime override selected in the UI', async () => {
    const server = await startMock();
    expect(server.selectScenario('req_orders', 'ok')).toBe(true);
    // Runtime override: ok.
    expect((await fetch(`${server.url}/orders/1`)).status).toBe(200);
    // Per-call override beats it.
    expect((await fetch(`${server.url}/orders/1?__scenario=down`)).status).toBe(503);
    // Clearing the runtime override restores automatic matching.
    expect(server.selectScenario('req_orders', null)).toBe(true);
    expect((await fetch(`${server.url}/orders/1`)).status).toBe(503);
  });

  it('reports the query reason in the request log', async () => {
    const server = await startMock();
    await fetch(`${server.url}/orders/1?__scenario=down`);
    const logs = server.getLogs();
    expect(logs.at(-1)).toMatchObject({
      status: 503,
      scenarioId: 'down',
      reason: 'query',
    });
  });
});
