import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../../electron/mcp/server.js';

const TOKENS = {
  'token-read': { id: 'mcp_read', name: 'Reader', scopes: ['read'], approval: 'always' },
  'token-write': { id: 'mcp_write', name: 'Builder', scopes: ['read', 'write'], approval: 'never' },
  'token-ask': { id: 'mcp_ask', name: 'Asker', scopes: ['read', 'write'], approval: 'always' },
  'token-session': {
    id: 'mcp_session',
    name: 'Session',
    scopes: ['read', 'write'],
    approval: 'session',
  },
};

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'vitest', version: '1.0.0' },
  },
};

function makeServer({ approve = 'allow', callTool } = {}) {
  const state = { revoked: new Set(), approvals: 0, calls: [], toolResults: [] };
  const server = createMcpServer({
    getClient(token) {
      if (state.revoked.has(token)) return null;
      return TOKENS[token] || null;
    },
    async callTool(payload) {
      state.calls.push(payload);
      if (callTool) return callTool(payload);
      const result = { ok: true, data: { tool: payload.tool, action: payload.action } };
      state.toolResults.push(result);
      return result;
    },
    async requestApproval() {
      state.approvals += 1;
      return approve;
    },
    version: '9.9.9',
  });
  return { server, state };
}

async function startServer(options) {
  const built = makeServer(options);
  const status = await built.server.start(0);
  return { ...built, status };
}

function request(url, { method = 'POST', token, sessionId, body, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (token) requestHeaders.Authorization = `Bearer ${token}`;
  if (sessionId) requestHeaders['Mcp-Session-Id'] = sessionId;
  requestHeaders.Accept = 'application/json, text/event-stream';
  if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
  return fetch(url, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function initialize(url, token) {
  const res = await request(url, { token, body: INITIALIZE });
  const sessionId = res.headers.get('mcp-session-id');
  const json = await res.json();
  // The spec's initialized notification; the server answers 202.
  await request(url, {
    token,
    sessionId,
    body: { jsonrpc: '2.0', method: 'notifications/initialized' },
  });
  return { res, json, sessionId };
}

function envelopeOf(json) {
  return JSON.parse(json.result.content[0].text);
}

describe('MCP HTTP server', () => {
  let running = null;

  afterEach(async () => {
    if (running) await running.server.stop();
    running = null;
  });

  it('rejects a request without a bearer token', async () => {
    running = await startServer();
    const res = await request(running.status.url, { body: INITIALIZE });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Relay MCP');
  });

  it('rejects an unknown or revoked token', async () => {
    running = await startServer();
    expect((await request(running.status.url, { token: 'nope', body: INITIALIZE })).status).toBe(
      401
    );

    running.state.revoked.add('token-read');
    expect(
      (await request(running.status.url, { token: 'token-read', body: INITIALIZE })).status
    ).toBe(401);
  });

  it('initializes a session and lists the tools', async () => {
    running = await startServer();
    const { res, json, sessionId } = await initialize(running.status.url, 'token-read');
    expect(res.status).toBe(200);
    expect(json.result.serverInfo).toMatchObject({ name: 'relay', version: '9.9.9' });
    expect(sessionId).toBeTruthy();

    const list = await request(running.status.url, {
      token: 'token-read',
      sessionId,
      body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    });
    const names = (await list.json()).result.tools.map((tool) => tool.name);
    expect(names).toContain('relay_execute');
    expect(names).toContain('relay_help');
  });

  it('runs a read tool and answers relay_help without approval', async () => {
    running = await startServer();
    const { sessionId } = await initialize(running.status.url, 'token-read');

    const info = await request(running.status.url, {
      token: 'token-read',
      sessionId,
      body: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'relay_app', arguments: { action: 'info' } },
      },
    });
    const infoJson = await info.json();
    expect(envelopeOf(infoJson)).toEqual({ ok: true, data: { tool: 'relay_app', action: 'info' } });
    expect(infoJson.result.isError).toBe(false);
    expect(running.state.approvals).toBe(0);

    const help = await request(running.status.url, {
      token: 'token-read',
      sessionId,
      body: {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'relay_help', arguments: { action: 'help' } },
      },
    });
    const helpEnvelope = envelopeOf(await help.json());
    expect(helpEnvelope.ok).toBe(true);
    expect(Object.keys(helpEnvelope.data.scopes)).toContain('write');
    expect(running.state.calls).toHaveLength(1);
  });

  it('refuses a write tool for a read-only client', async () => {
    running = await startServer();
    const { sessionId } = await initialize(running.status.url, 'token-read');
    const res = await request(running.status.url, {
      token: 'token-read',
      sessionId,
      body: {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'relay_collections',
          arguments: { action: 'create', params: { name: 'AI Review' } },
        },
      },
    });
    const json = await res.json();
    expect(json.result.isError).toBe(true);
    expect(envelopeOf(json).error.code).toBe('forbidden_scope');
    expect(running.state.calls).toHaveLength(0);
  });

  it('denies when the approval is refused and runs when it is allowed', async () => {
    running = await startServer({ approve: 'deny' });
    const { sessionId } = await initialize(running.status.url, 'token-ask');
    const call = {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'relay_collections',
        arguments: { action: 'create', params: { name: 'AI Review' } },
      },
    };
    const denied = await (await request(running.status.url, {
      token: 'token-ask',
      sessionId,
      body: call,
    })).json();
    expect(envelopeOf(denied).error.code).toBe('denied');
    expect(running.state.approvals).toBe(1);
    expect(running.state.calls).toHaveLength(0);

    await running.server.stop();
    running = await startServer({ approve: 'allow' });
    const fresh = await initialize(running.status.url, 'token-ask');
    const allowed = await (await request(running.status.url, {
      token: 'token-ask',
      sessionId: fresh.sessionId,
      body: { ...call, id: 7 },
    })).json();
    expect(envelopeOf(allowed).ok).toBe(true);
    expect(running.state.calls).toHaveLength(1);
    expect(running.state.approvals).toBe(1);
  });

  it('asks once for a session-policy client and then reuses the grant', async () => {
    running = await startServer({ approve: 'allow_session' });
    const { sessionId } = await initialize(running.status.url, 'token-session');
    const call = {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'relay_collections',
        arguments: { action: 'create', params: { name: 'AI Review' } },
      },
    };
    const first = await request(running.status.url, {
      token: 'token-session',
      sessionId,
      body: { ...call, id: 8 },
    });
    expect(envelopeOf(await first.json()).ok).toBe(true);

    const second = await request(running.status.url, {
      token: 'token-session',
      sessionId,
      body: { ...call, id: 9 },
    });
    expect(envelopeOf(await second.json()).ok).toBe(true);
    expect(running.state.approvals).toBe(1);
    expect(running.state.calls).toHaveLength(2);

    // A token rotation clears the grant.
    running.server.clearGrants('mcp_session');
    const third = await request(running.status.url, {
      token: 'token-session',
      sessionId,
      body: { ...call, id: 10 },
    });
    expect(envelopeOf(await third.json()).ok).toBe(true);
    expect(running.state.approvals).toBe(2);
  });

  it('never asks a never-policy client', async () => {
    running = await startServer();
    const { sessionId } = await initialize(running.status.url, 'token-write');
    const res = await request(running.status.url, {
      token: 'token-write',
      sessionId,
      body: {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: 'relay_collections',
          arguments: { action: 'create', params: { name: 'AI Review' } },
        },
      },
    });
    expect(envelopeOf(await res.json()).ok).toBe(true);
    expect(running.state.approvals).toBe(0);
  });

  it('reports a renderer failure as an error envelope', async () => {
    running = await startServer({
      callTool: async () => ({ ok: false, error: { code: 'not_found', message: 'gone' } }),
    });
    const { sessionId } = await initialize(running.status.url, 'token-write');
    const res = await request(running.status.url, {
      token: 'token-write',
      sessionId,
      body: {
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: { name: 'relay_app', arguments: { action: 'info' } },
      },
    });
    const json = await res.json();
    expect(json.result.isError).toBe(true);
    expect(envelopeOf(json)).toEqual({
      ok: false,
      error: { code: 'not_found', message: 'gone' },
    });
  });

  it('rejects an unknown session, a cross-client session and a bare GET', async () => {
    running = await startServer();
    const { sessionId } = await initialize(running.status.url, 'token-read');

    const unknown = await request(running.status.url, {
      token: 'token-read',
      sessionId: 'not-a-session',
      body: { jsonrpc: '2.0', id: 13, method: 'tools/list' },
    });
    expect(unknown.status).toBe(404);

    const crossClient = await request(running.status.url, {
      token: 'token-write',
      sessionId,
      body: { jsonrpc: '2.0', id: 14, method: 'tools/list' },
    });
    expect(crossClient.status).toBe(403);

    const bareGet = await request(running.status.url, { method: 'GET', token: 'token-read' });
    expect(bareGet.status).toBe(405);
  });

  it('rejects a browser origin and a foreign Host header', async () => {
    running = await startServer();
    const withOrigin = await request(running.status.url, {
      token: 'token-read',
      body: INITIALIZE,
      headers: { Origin: 'https://evil.test' },
    });
    expect(withOrigin.status).toBe(403);

    const port = running.status.port;
    const hostStatus = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: {
            Host: 'evil.test',
            Authorization: 'Bearer token-read',
            'Content-Type': 'application/json',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.on('error', reject);
      req.end(JSON.stringify(INITIALIZE));
    });
    expect(hostStatus).toBe(403);
  });

  it('rejects an oversized body and an unknown path', async () => {
    running = await startServer();
    const big = 'x'.repeat(1024 * 1024 + 10);
    const res = await request(running.status.url, { token: 'token-read', body: big });
    expect(res.status).toBe(413);

    const missing = await request(running.status.url.replace('/mcp', '/nope'), {
      token: 'token-read',
      body: INITIALIZE,
    });
    expect(missing.status).toBe(404);
  });
});
