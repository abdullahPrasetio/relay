// MCP runtime: owns the listener lifecycle, the client registry and the
// main->renderer bridge.
//
// The renderer owns all workspace data, so a tool call is forwarded to the
// main window over IPC and answered on `mcp:invoke-result`. Approvals are
// forwarded on `mcp:approval` and answered on `mcp:approval-result`.
//
// Nothing here logs params, response bodies or tokens: `recentCalls` keeps
// only {at, clientId, clientName, tool, action, ok}.

import {
  normalizeMcpConfig,
  sanitizeMcpConfig,
  isValidPort,
  createClientRecord,
  updateClientRecord,
  removeClient,
  rotateClientToken,
  verifyToken,
  touchClient,
} from './config.js';
import { createMcpServer } from './server.js';

const RECENT_CALLS_LIMIT = 100;
const RENDERER_TIMEOUT_MS = 5 * 60_000 + 5_000;
const APPROVAL_TIMEOUT_MS = 60_000;

function unavailable() {
  return {
    ok: false,
    error: { code: 'app_unavailable', message: 'The Relay window is not available.' },
  };
}

export function createMcpRuntime({ store, getWindow, appVersion = '0.0.0' }) {
  if (!store) throw new Error('createMcpRuntime requires the store');

  let config = normalizeMcpConfig(store.getMcpConfig());
  const storedAudit =
    typeof store.getMcpAudit === 'function' ? store.getMcpAudit() : [];
  const recentCalls = (Array.isArray(storedAudit) ? storedAudit : [])
    .filter((entry) => entry && typeof entry === 'object' && entry.tool && entry.action)
    .slice(0, RECENT_CALLS_LIMIT);
  const pendingCalls = new Map();
  const pendingApprovals = new Map();
  let callSeq = 0;
  let watchedWindow = null;
  let disposed = false;

  const server = createMcpServer({
    getClient: (token) => verifyToken(config, token),
    callTool: (payload) => invokeRenderer(payload),
    requestApproval: (payload) => askApproval(payload),
    version: appVersion,
  });

  function persist(next) {
    config = normalizeMcpConfig(next);
    try {
      store.setMcpConfig(config);
    } catch {
      /* a failed write must not break the in-memory config */
    }
    return config;
  }

  function sanitizedClient(client) {
    const copy = { ...client, scopes: [...client.scopes] };
    delete copy.tokenHash;
    return copy;
  }

  function recordCall(entry) {
    recentCalls.unshift(entry);
    if (recentCalls.length > RECENT_CALLS_LIMIT) recentCalls.length = RECENT_CALLS_LIMIT;
    try {
      store.setMcpAudit?.(recentCalls);
    } catch {
      /* audit persistence must not break the call */
    }
  }

  function markUsed(clientId) {
    const result = touchClient(config, clientId);
    if (result.changed) persist(result.config);
  }

  function windowReady() {
    const win = typeof getWindow === 'function' ? getWindow() : null;
    if (!win || win.isDestroyed?.()) return null;
    const contents = win.webContents;
    if (!contents || contents.isDestroyed?.()) return null;
    return win;
  }

  // Any renderer teardown makes in-flight calls impossible to answer; failing
  // them fast beats waiting out the timeout.
  function rejectPending(reason) {
    for (const [callId, entry] of pendingCalls) {
      pendingCalls.delete(callId);
      clearTimeout(entry.timer);
      entry.resolve({
        ok: false,
        error: { code: 'app_unavailable', message: reason },
      });
    }
    for (const [approvalId, entry] of pendingApprovals) {
      pendingApprovals.delete(approvalId);
      clearTimeout(entry.timer);
      entry.resolve('deny');
    }
  }

  function watchWindow(win) {
    if (!win || win === watchedWindow) return;
    watchedWindow = win;
    const fail = () => rejectPending('The Relay window went away.');
    try {
      win.webContents.on('render-process-gone', fail);
      win.webContents.on('did-start-loading', fail);
      win.on('closed', fail);
    } catch {
      /* window already gone */
    }
  }

  function invokeRenderer({ client, tool, action, params }) {
    const win = windowReady();
    if (!win) return Promise.resolve(unavailable());
    watchWindow(win);

    callSeq += 1;
    const callId = `mcp_call_${Date.now().toString(36)}_${callSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingCalls.delete(callId);
        resolve({
          ok: false,
          error: { code: 'invoke_timeout', message: 'Relay did not answer in time.' },
        });
      }, RENDERER_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      pendingCalls.set(callId, {
        resolve: (result) => {
          resolve(result);
          recordCall({
            at: Date.now(),
            clientId: client.id,
            clientName: client.name,
            tool,
            action,
            ok: result?.ok === true,
            sensitive: result?.sensitive === true,
          });
          markUsed(client.id);
        },
        timer,
      });
      try {
        win.webContents.send('mcp:invoke', {
          callId,
          client: {
            id: client.id,
            name: client.name,
            scopes: Array.isArray(client.scopes) ? [...client.scopes] : [],
          },
          tool,
          action,
          params,
        });
      } catch {
        clearTimeout(timer);
        pendingCalls.delete(callId);
        resolve(unavailable());
      }
    });
  }

  function askApproval({ client, tool, action, scope, summary, params, policy }) {
    const win = windowReady();
    if (!win) return Promise.resolve('deny');
    watchWindow(win);
    try {
      if (win.isMinimized?.()) win.restore();
      win.show();
      win.focus();
    } catch {
      /* focus is best-effort */
    }

    callSeq += 1;
    const approvalId = `mcp_approval_${Date.now().toString(36)}_${callSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingApprovals.delete(approvalId);
        resolve('deny');
      }, APPROVAL_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      pendingApprovals.set(approvalId, { resolve, timer });
      try {
        win.webContents.send('mcp:approval', {
          approvalId,
          client: { id: client.id, name: client.name },
          tool,
          action,
          scope,
          summary,
          params,
          policy,
        });
      } catch {
        clearTimeout(timer);
        pendingApprovals.delete(approvalId);
        resolve('deny');
      }
    });
  }

  async function start() {
    if (disposed) return { ok: false, error: 'MCP runtime is disposed.' };
    try {
      const status = await server.start(config.port);
      return { ok: true, status };
    } catch (err) {
      return {
        ok: false,
        error: err?.message || String(err),
        status: server.status(),
      };
    }
  }

  async function stop() {
    rejectPending('The MCP server stopped.');
    const status = await server.stop();
    return { ok: true, status };
  }

  function status() {
    const base = server.status();
    return {
      ...base,
      enabled: config.enabled,
      clients: config.clients.map(sanitizedClient),
      recentCalls: recentCalls.slice(),
    };
  }

  return {
    async startIfEnabled() {
      if (!config.enabled) return { ok: true, status: status() };
      return start();
    },
    start,
    stop,
    status,
    getConfig() {
      return sanitizeMcpConfig(config);
    },
    async setEnabled(enabled) {
      persist({ ...config, enabled: enabled === true });
      if (enabled === true) return start();
      const stopped = await stop();
      return { ok: true, status: { ...stopped.status, enabled: false } };
    },
    async setPort(port) {
      const next = Number(port);
      if (!isValidPort(next)) {
        return { ok: false, error: 'Port must be a whole number between 1024 and 65535.' };
      }
      if (next === config.port) return { ok: true, status: status() };
      const wasRunning = server.status().running;
      if (wasRunning) await server.stop();
      persist({ ...config, port: next });
      if (config.enabled) return start();
      return { ok: true, status: status() };
    },
    createClient(payload = {}) {
      let record;
      try {
        record = createClientRecord(payload, config);
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
      persist({ ...config, clients: [...config.clients, record.client] });
      return { ok: true, client: sanitizedClient(record.client), token: record.token };
    },
    updateClient(payload = {}) {
      const id = typeof payload.id === 'string' ? payload.id : '';
      const result = updateClientRecord(config, id, payload);
      if (!result.ok) return result;
      persist(result.config);
      server.clearGrants(id);
      return { ok: true, client: sanitizedClient(result.client) };
    },
    revokeClient(id) {
      const result = removeClient(config, id);
      if (!result.ok) return result;
      persist(result.config);
      server.clearGrants(id);
      return { ok: true };
    },
    rotateToken(id) {
      const result = rotateClientToken(config, id);
      if (!result.ok) return result;
      persist(result.config);
      server.clearGrants(id);
      return { ok: true, client: sanitizedClient(result.client), token: result.token };
    },
    // Called by the IPC layer when the renderer answers a forwarded call.
    resolveCall(payload = {}) {
      const entry = pendingCalls.get(payload.callId);
      if (!entry) return false;
      pendingCalls.delete(payload.callId);
      clearTimeout(entry.timer);
      entry.resolve(
        payload.ok === true
          ? {
              ok: true,
              sensitive: payload.sensitive === true,
              data: payload.result ?? null,
            }
          : {
              ok: false,
              error: {
                code: typeof payload.error?.code === 'string' ? payload.error.code : 'renderer_error',
                message:
                  typeof payload.error?.message === 'string'
                    ? payload.error.message
                    : 'Relay could not complete the action.',
              },
            }
      );
      return true;
    },
    resolveApproval(payload = {}) {
      const entry = pendingApprovals.get(payload.approvalId);
      if (!entry) return false;
      pendingApprovals.delete(payload.approvalId);
      clearTimeout(entry.timer);
      const decision = payload.decision;
      entry.resolve(
        decision === 'allow' || decision === 'allow_session' ? decision : 'deny'
      );
      return true;
    },
    dispose() {
      disposed = true;
      rejectPending('The MCP runtime was disposed.');
      return stop();
    },
  };
}
