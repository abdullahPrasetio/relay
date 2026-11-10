import { describe, expect, it } from 'vitest';
import { createCloudClient } from '../../electron/cloud/client.js';

function envelope(data, status = 200) {
  return new Response(JSON.stringify({ status: true, message: 'ok', data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function noContent() {
  return new Response(null, { status: 204 });
}

function fakeTokenStore() {
  return {
    async get() {
      return null;
    },
    async set() {},
    async clear() {},
    async getDeviceLabel() {
      return null;
    },
  };
}

function bodyOf(init) {
  return init?.body ? JSON.parse(init.body) : undefined;
}

describe('cloud client server mocks', () => {
  it('calls the mock CRUD, generation, log, and scenario routes', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      const pathname = new URL(url).pathname;
      calls.push({ url, pathname, init });
      if (pathname.endsWith('/workspaces/ws_1/mocks') && init?.method === 'GET') {
        return envelope({
          mockBaseUrl: 'http://relay.test/mock/ws_1',
          endpoints: [{ id: 'mock_1', method: 'GET', path: '/orders', scenarios: [] }],
        });
      }
      if (pathname.endsWith('/workspaces/ws_1/mocks') && init?.method === 'POST') {
        return envelope({ id: 'mock_new', method: 'POST', path: '/created' }, 201);
      }
      if (pathname.endsWith('/mocks/mock_1') && init?.method === 'PATCH') {
        return envelope({ id: 'mock_1', enabled: false, evaluationMode: 'manual' });
      }
      if (pathname.endsWith('/mocks/mock_1') && init?.method === 'DELETE') {
        return noContent();
      }
      if (pathname.endsWith('/workspaces/ws_1/mock-logs')) {
        return envelope({
          mockBaseUrl: 'http://relay.test/mock/ws_1',
          logs: [{ id: 1, method: 'GET', path: '/orders', statusCode: 200 }],
        });
      }
      if (pathname.endsWith('/mocks/from-request/req_1')) {
        return envelope({ id: 'mock_req', path: '/orders/{id}' }, 201);
      }
      if (pathname.endsWith('/mocks/from-collection/col_1')) {
        return envelope({
          mockBaseUrl: 'http://relay.test/mock/ws_1',
          created: [{ id: 'mock_a' }],
          skipped: [{ requestId: 'req_b', reason: 'duplicate' }],
        });
      }
      if (pathname.endsWith('/mocks/mock_1/scenarios') && init?.method === 'GET') {
        return envelope([{ id: 'sc_1', name: 'paid' }]);
      }
      if (pathname.endsWith('/mocks/mock_1/scenarios') && init?.method === 'POST') {
        return envelope({ id: 'sc_new', name: 'created' }, 201);
      }
      if (pathname.endsWith('/scenarios/sc_1') && init?.method === 'PATCH') {
        return envelope({ id: 'sc_1', name: 'updated' });
      }
      if (pathname.endsWith('/scenarios/sc_1') && init?.method === 'DELETE') {
        return noContent();
      }
      throw new Error(`unexpected request: ${init?.method} ${pathname}`);
    };

    const client = createCloudClient({
      baseUrl: 'http://relay.test',
      fetchImpl,
      tokenStore: fakeTokenStore(),
    });

    await expect(client.mocks('ws_1')).resolves.toEqual({
      mockBaseUrl: 'http://relay.test/mock/ws_1',
      endpoints: [{ id: 'mock_1', method: 'GET', path: '/orders', scenarios: [] }],
    });
    await expect(
      client.createMock('ws_1', {
        method: 'post',
        path: 'created',
        responseHeaders: [{ key: 'X-Test', value: '1', enabled: true }],
        responseBody: '{"ok":true}',
      })
    ).resolves.toMatchObject({ id: 'mock_new' });
    await expect(
      client.updateMock('mock_1', {
        enabled: false,
        evaluationMode: 'manual',
        activeScenarioId: null,
      })
    ).resolves.toMatchObject({ enabled: false });
    await expect(client.deleteMock('mock_1')).resolves.toBeNull();
    await expect(client.mockLogs('ws_1', { limit: 10 })).resolves.toMatchObject({
      logs: [{ statusCode: 200 }],
    });
    await expect(
      client.mockFromRequest('ws_1', 'req_1', { path: '/orders/{id}' })
    ).resolves.toMatchObject({ path: '/orders/{id}' });
    await expect(client.mockFromCollection('ws_1', 'col_1', {})).resolves.toEqual({
      mockBaseUrl: 'http://relay.test/mock/ws_1',
      created: [{ id: 'mock_a' }],
      skipped: [{ requestId: 'req_b', reason: 'duplicate' }],
    });
    await expect(client.mockScenarios('mock_1')).resolves.toEqual([
      { id: 'sc_1', name: 'paid' },
    ]);
    await expect(
      client.createMockScenario('mock_1', { name: 'created', conditions: [] })
    ).resolves.toMatchObject({ id: 'sc_new' });
    await expect(
      client.updateMockScenario('sc_1', { name: 'updated' })
    ).resolves.toMatchObject({ name: 'updated' });
    await expect(client.deleteMockScenario('sc_1')).resolves.toBeNull();

    const create = calls.find((call) => call.pathname.endsWith('/mocks') && call.init?.method === 'POST');
    expect(bodyOf(create.init)).toEqual({
      method: 'POST',
      path: '/created',
      responseHeaders: { 'X-Test': '1' },
      responseBody: '{"ok":true}',
    });
    const update = calls.find((call) => call.pathname.endsWith('/mocks/mock_1') && call.init?.method === 'PATCH');
    expect(bodyOf(update.init)).toEqual({
      enabled: false,
      evaluationMode: 'manual',
      activeScenarioId: null,
    });
    const logs = calls.find((call) => call.pathname.endsWith('/mock-logs'));
    expect(new URL(logs.url).searchParams.get('limit')).toBe('10');
    const override = calls.find((call) => call.pathname.endsWith('/mocks/from-request/req_1'));
    expect(bodyOf(override.init)).toEqual({ path: '/orders/{id}' });
  });
});
