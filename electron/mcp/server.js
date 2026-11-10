// Local MCP HTTP endpoint.
//
// One `McpServer` + `StreamableHTTPServerTransport` pair per session. Every
// request must carry a client bearer token; the client's scopes and approval
// policy decide what the tool call may do. The renderer performs the actual
// work (it owns the workspace data), so a tool call is a round-trip through
// the main window.
//
// Safety rules enforced here (not in the renderer):
//   - loopback bind only, Host/Origin checks against DNS rebinding
//   - bearer token on every request, revoked tokens fail closed
//   - 1 MiB request cap, 256 KiB tool-output cap
//   - no params/bodies/tokens in logs

import http from 'node:http';
import crypto from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { MCP_TOOLS, getActionSpec, validateAction, summarizeAction, helpPayload } from '../../shared/mcpTools.js';

export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_OUTPUT_BYTES = 256 * 1024;
export const OUTPUT_PREVIEW_BYTES = 4 * 1024;
export const APPROVAL_TIMEOUT_MS = 60_000;
export const INVOKE_TIMEOUT_MS = 5 * 60_000;
export const SESSION_IDLE_MS = 30 * 60_000;

const BEARER = /^Bearer\s+(\S+)\s*$/i;

function sendJson(res, status, payload, headers = {}) {
  const body = payload == null ? '' : JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return; // keep draining so the 413 response can be sent
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        tooLarge = true;
        const err = new Error('Request body too large');
        err.status = 413;
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (!tooLarge) reject(err);
    });
  });
}

function failEnvelope(code, message) {
  return { ok: false, error: { code, message } };
}

function serializeEnvelope(envelope) {
  const text = JSON.stringify(envelope);
  if (Buffer.byteLength(text, 'utf8') <= MAX_OUTPUT_BYTES) return text;
  const dataText = JSON.stringify(envelope?.data ?? null);
  return JSON.stringify({
    ok: envelope?.ok === true,
    data: {
      truncated: true,
      bytes: Buffer.byteLength(text, 'utf8'),
      preview: dataText.slice(0, OUTPUT_PREVIEW_BYTES),
    },
  });
}

/**
 * Resolve a tool call to its result envelope.
 * Never throws: every failure becomes `{ok:false, error:{code,message}}`.
 */
async function resolveAction({
  client,
  tool,
  action,
  params,
  callTool,
  requestApproval,
  grantKey,
  grants,
}) {
  const spec = getActionSpec(tool, action);
  if (!spec) return failEnvelope('invalid_params', `Unknown action "${action}" for "${tool}".`);

  const validation = validateAction(tool, action, params);
  if (!validation.ok) return validation;
  const cleanParams = validation.params;

  if (tool === 'relay_help') {
    return { ok: true, data: helpPayload() };
  }

  if (!spec.scope || !Array.isArray(client.scopes) || !client.scopes.includes(spec.scope)) {
    return failEnvelope(
      'forbidden_scope',
      `This MCP client is not allowed the "${spec.scope}" scope.`
    );
  }

  if (spec.approval) {
    const key = grantKey(client.id, tool, action);
    const granted = client.approval === 'session' && grants.has(key);
    if (client.approval !== 'never' && !granted) {
      const answer = await withTimeout(
        requestApproval({
          client,
          tool,
          action,
          scope: spec.scope,
          summary: summarizeAction(tool, action, cleanParams),
          params: cleanParams,
          policy: client.approval,
        }),
        APPROVAL_TIMEOUT_MS,
        'deny'
      );
      if (answer === 'timeout') {
        return failEnvelope('approval_timeout', 'The approval request timed out.');
      }
      if (answer !== 'allow' && answer !== 'allow_session') {
        return failEnvelope('denied', 'The user denied this action.');
      }
      if (answer === 'allow_session') grants.add(key);
    }
  }

  const result = await withTimeout(
    callTool({ client, tool, action, params: cleanParams }),
    INVOKE_TIMEOUT_MS,
    failEnvelope('invoke_timeout', 'The Relay window did not finish the action in time.')
  );
  if (result === 'timeout') {
    return failEnvelope('invoke_timeout', 'The Relay window did not finish the action in time.');
  }
  if (!result || typeof result !== 'object') {
    return failEnvelope('renderer_error', 'Relay returned no result.');
  }
  if (result.ok === true) return { ok: true, data: result.data ?? result.result ?? null };
  if (result.ok === false) {
    const error = result.error || {};
    return failEnvelope(
      typeof error.code === 'string' ? error.code : 'renderer_error',
      typeof error.message === 'string' ? error.message : 'Relay could not complete the action.'
    );
  }
  return { ok: true, data: result };
}

// Race a promise against a timeout. Resolves with `timeoutValue` on timeout;
// rejections become the same value so callers never see a throw.
function withTimeout(promise, ms, timeoutValue) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve('timeout');
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(timeoutValue === null ? 'timeout' : timeoutValue);
      }
    );
  });
}

function buildServer({ client, callTool, requestApproval, grants, version }) {
  const server = new McpServer({ name: 'relay', version: version || '0.0.0' });
  const grantKey = (clientId, tool, action) => `${clientId}:${tool}:${action}`;

  for (const [toolName, tool] of Object.entries(MCP_TOOLS)) {
    const actionNames = Object.keys(tool.actions);
    server.registerTool(
      toolName,
      {
        description: tool.description,
        inputSchema: {
          action: z.enum(actionNames),
          params: z.record(z.string(), z.unknown()).optional(),
        },
      },
      async ({ action, params }) => {
        const envelope = await resolveAction({
          client,
          tool: toolName,
          action,
          params,
          callTool,
          requestApproval,
          grantKey,
          grants,
        });
        return {
          content: [{ type: 'text', text: serializeEnvelope(envelope) }],
          isError: envelope.ok !== true,
        };
      }
    );
  }
  return server;
}

/**
 * Create the MCP HTTP server.
 * `getClient(token)` returns the client record for a bearer token (or null);
 * `callTool`/`requestApproval` bridge to the renderer.
 */
export function createMcpServer({ getClient, callTool, requestApproval, version = '0.0.0' }) {
  if (typeof getClient !== 'function') throw new Error('createMcpServer requires getClient');
  if (typeof callTool !== 'function') throw new Error('createMcpServer requires callTool');
  if (typeof requestApproval !== 'function') {
    throw new Error('createMcpServer requires requestApproval');
  }

  let httpServer = null;
  let listeningPort = null;
  let lastError = '';
  let allowedHosts = new Set();
  // Grants are per client+action and cleared whenever the client changes.
  const grants = new Set();
  // Mcp-Session-Id -> { clientId, server, transport, lastAt }
  const sessions = new Map();
  let sweeper = null;

  function sessionFor(req) {
    const raw = req.headers['mcp-session-id'];
    const id = Array.isArray(raw) ? raw[0] : raw;
    if (!id) return null;
    const session = sessions.get(id);
    if (!session) return null;
    session.lastAt = Date.now();
    return session;
  }

  async function closeSession(id) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    try {
      await session.transport.close();
    } catch {
      /* closing an already-dead transport is not an error */
    }
    try {
      await session.server.close();
    } catch {
      /* ignore */
    }
  }

  async function createSession(client, transport) {
    const server = buildServer({
      client,
      callTool,
      requestApproval,
      grants,
      version,
    });
    await server.connect(transport);
    return server;
  }

  function authorizedClient(req) {
    const header = req.headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    const match = typeof value === 'string' ? BEARER.exec(value) : null;
    if (!match) return null;
    try {
      return getClient(match[1]) || null;
    } catch {
      return null;
    }
  }

  function hostAllowed(req) {
    const host = req.headers.host;
    if (typeof host !== 'string' || !host) return false;
    return allowedHosts.has(host.toLowerCase());
  }

  async function handle(req, res) {
    // DNS-rebinding hardening: a browser page must never reach this endpoint.
    if (req.headers.origin) {
      sendJson(res, 403, { error: 'origin_not_allowed' });
      return;
    }
    if (!hostAllowed(req)) {
      sendJson(res, 403, { error: 'host_not_allowed' });
      return;
    }

    const url = req.url || '';
    const path = url.split('?')[0];
    if (path !== '/mcp') {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE') {
      res.writeHead(405, { Allow: 'POST, GET, DELETE' });
      res.end();
      return;
    }

    const client = authorizedClient(req);
    if (!client) {
      sendJson(
        res,
        401,
        { error: 'unauthorized' },
        { 'WWW-Authenticate': 'Bearer realm="Relay MCP"' }
      );
      return;
    }

    if (req.method === 'DELETE') {
      const session = sessionFor(req);
      if (!session) {
        sendJson(res, 404, { error: 'unknown_session' });
        return;
      }
      if (session.clientId !== client.id) {
        sendJson(res, 403, { error: 'session_client_mismatch' });
        return;
      }
      await closeSession(session.transport.sessionId);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET') {
      const session = sessionFor(req);
      if (!session) {
        res.writeHead(405, { Allow: 'POST, DELETE' });
        res.end();
        return;
      }
      if (session.clientId !== client.id) {
        sendJson(res, 403, { error: 'session_client_mismatch' });
        return;
      }
      await session.transport.handleRequest(req, res);
      return;
    }

    // POST
    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      if (err?.status === 413) {
        sendJson(res, 413, { error: 'body_too_large' });
        return;
      }
      sendJson(res, 400, { error: 'bad_request' });
      return;
    }
    let parsed;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }

    const sessionIdHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

    if (sessionId) {
      const session = sessionFor(req);
      if (!session) {
        sendJson(res, 404, { error: 'unknown_session' });
        return;
      }
      if (session.clientId !== client.id) {
        sendJson(res, 403, { error: 'session_client_mismatch' });
        return;
      }
      await session.transport.handleRequest(req, res, parsed);
      return;
    }

    // New session: the transport generates the id and reports it through
    // onsessioninitialized, so the map entry is registered before the
    // response headers are flushed.
    let sessionServer = null;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, {
          clientId: client.id,
          server: sessionServer,
          transport,
          lastAt: Date.now(),
        });
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) sessions.delete(id);
    };
    sessionServer = await createSession(client, transport);
    try {
      await transport.handleRequest(req, res, parsed);
    } catch (err) {
      lastError = err?.message || String(err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      else res.end();
    }
  }

  function status() {
    return {
      running: !!httpServer,
      port: listeningPort,
      url: listeningPort ? `http://127.0.0.1:${listeningPort}/mcp` : null,
      error: lastError,
      sessions: sessions.size,
    };
  }

  async function start(port) {
    if (httpServer) return status();
    lastError = '';
    const server = http.createServer((req, res) => {
      handle(req, res).catch((err) => {
        lastError = err?.message || String(err);
        if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
        else res.end();
      });
    });
    // No keep-alive socket should outlive the listener by long.
    server.keepAliveTimeout = 5000;

    await new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        lastError = err?.message || String(err);
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });

    httpServer = server;
    listeningPort = server.address().port;
    allowedHosts = new Set([
      `127.0.0.1:${listeningPort}`,
      `localhost:${listeningPort}`,
      `[::1]:${listeningPort}`,
    ]);

    sweeper = setInterval(() => {
      const cutoff = Date.now() - SESSION_IDLE_MS;
      for (const [id, session] of sessions) {
        if (session.lastAt < cutoff) closeSession(id).catch(() => {});
      }
    }, 60_000);
    if (typeof sweeper.unref === 'function') sweeper.unref();

    return status();
  }

  async function stop() {
    if (sweeper) {
      clearInterval(sweeper);
      sweeper = null;
    }
    const ids = [...sessions.keys()];
    for (const id of ids) await closeSession(id);
    const server = httpServer;
    httpServer = null;
    listeningPort = null;
    allowedHosts = new Set();
    if (!server) return status();
    await new Promise((resolve) => {
      server.close(() => resolve());
      // Node 18+: drop idle keep-alive sockets so close() is prompt.
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    });
    return status();
  }

  return {
    start,
    stop,
    status,
    clearGrants(clientId) {
      if (!clientId) {
        grants.clear();
        return;
      }
      for (const key of [...grants]) {
        if (key.startsWith(`${clientId}:`)) grants.delete(key);
      }
    },
  };
}
