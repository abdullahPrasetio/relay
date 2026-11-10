import crypto from 'node:crypto';
import os from 'node:os';
import { startMockServer } from './mock-server.js';

// IPC surface for the local mock server.
//
// Two binding modes, persisted in the main-process store:
//   local  -> 127.0.0.1 only, no token (the original behaviour)
//   server -> a LAN interface or 0.0.0.0, always token-protected
//
// The token itself is never persisted: only its SHA-256 digest and a short
// prefix are stored, and `mock:rotate-token` returns a fresh one exactly once.
//
// Wiring contract for the orchestrator (electron/main.js):
//   1. inside registerIpc(): registerMockIpc({ ipcMain, store });
//   2. on shutdown (before-quit / window-all-closed): await stopMockServer().

const MODES = ['local', 'server'];
export const MOCK_TOKEN_PREFIX = 'relay_mock_';

let current = null; // { port, url, urls, mode, host, tokenRequired, stop, getLogs, getRoutes, setRoutes, selectScenario }

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function newToken() {
  return MOCK_TOKEN_PREFIX + crypto.randomBytes(24).toString('base64url');
}

function tokenPrefixOf(token) {
  return MOCK_TOKEN_PREFIX + token.slice(MOCK_TOKEN_PREFIX.length, MOCK_TOKEN_PREFIX.length + 6);
}

/** IPv4 addresses this machine can be reached on (0.0.0.0 first). */
export function localHosts() {
  const out = [{ address: '0.0.0.0', label: 'All interfaces' }];
  for (const [name, entries] of Object.entries(os.networkInterfaces() || {})) {
    for (const entry of entries || []) {
      if (!entry || entry.family !== 'IPv4' || entry.internal) continue;
      if (out.some((host) => host.address === entry.address)) continue;
      out.push({ address: entry.address, label: name });
    }
  }
  return out;
}

function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const mode = MODES.includes(input.mode) ? input.mode : 'local';
  const hosts = localHosts();
  const host = hosts.some((entry) => entry.address === input.host) ? input.host : '0.0.0.0';
  const tokenHash = /^[0-9a-f]{64}$/i.test(String(input.tokenHash || ''))
    ? String(input.tokenHash)
    : '';
  const tokenPrefix =
    tokenHash && typeof input.tokenPrefix === 'string' ? input.tokenPrefix : '';
  return { mode, host, tokenHash, tokenPrefix };
}

function displayUrls(mode, host, port) {
  if (!port) return [];
  if (mode === 'local') return [`http://127.0.0.1:${port}`];
  if (host === '0.0.0.0') {
    const lan = localHosts()
      .filter((entry) => entry.address !== '0.0.0.0')
      .map((entry) => `http://${entry.address}:${port}`);
    return [...lan, `http://127.0.0.1:${port}`];
  }
  return [`http://${host}:${port}`];
}

async function stopCurrent() {
  const server = current;
  current = null;
  if (!server) return;
  try {
    await server.stop();
  } catch {
    /* stopping must always succeed from the caller's point of view */
  }
}

function emptyStatus(config) {
  return {
    running: false,
    url: null,
    urls: [],
    port: null,
    mode: config.mode,
    host: config.mode === 'server' ? config.host : '127.0.0.1',
    tokenRequired: config.mode === 'server' && Boolean(config.tokenHash),
    tokenPrefix: config.tokenPrefix,
    routes: [],
    logs: [],
  };
}

function readCollections(store, collectionId) {
  const data = store?.getAll?.() || {};
  const workspaces = Array.isArray(data.workspaces) ? data.workspaces : [];

  let collections;
  if (workspaces.length) {
    const workspace = workspaces.find((w) => w.id === data.activeWorkspaceId) || workspaces[0];
    collections = Array.isArray(workspace?.collections) ? workspace.collections : [];
  } else {
    // Legacy flat shape: only reachable before the renderer migrates.
    collections = Array.isArray(data.collections) ? data.collections : [];
  }

  if (!collectionId) return { collections, error: null };

  const selected = collections.filter((collection) => collection?.id === collectionId);
  if (!selected.length) return { collections: [], error: 'Collection not found' };
  return { collections: selected, error: null };
}

export function registerMockIpc({ ipcMain, store }) {
  if (!ipcMain) throw new Error('registerMockIpc requires ipcMain');
  if (!store) throw new Error('registerMockIpc requires the main-process store');

  const readConfig = () => normalizeConfig(store.getMockServerConfig());
  const writeConfig = (next) => {
    const normalized = normalizeConfig(next);
    store.setMockServerConfig(normalized);
    return normalized;
  };

  // Make registration idempotent so a repeated call cannot throw.
  for (const channel of [
    'mock:start',
    'mock:stop',
    'mock:status',
    'mock:reload',
    'mock:select',
    'mock:get-config',
    'mock:set-config',
    'mock:rotate-token',
  ]) {
    try {
      ipcMain.removeHandler(channel);
    } catch {
      /* handler was not registered */
    }
  }

  // Binding mode, token state and the interfaces the user can choose from.
  // `hosts` is main-side because the renderer cannot enumerate interfaces.
  ipcMain.handle('mock:get-config', () => {
    const config = readConfig();
    return {
      mode: config.mode,
      host: config.host,
      tokenRequired: config.mode === 'server' && Boolean(config.tokenHash),
      tokenPrefix: config.tokenPrefix,
      hosts: localHosts(),
    };
  });

  ipcMain.handle('mock:set-config', async (_event, payload = {}) => {
    const input = payload && typeof payload === 'object' ? payload : {};
    if (input.mode !== undefined && !MODES.includes(input.mode)) {
      return { ok: false, error: 'Mode must be local or server.' };
    }
    const currentConfig = readConfig();
    const next = {
      ...currentConfig,
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
      ...(input.host !== undefined ? { host: input.host } : {}),
    };
    if (next.mode === 'server') {
      if (!localHosts().some((entry) => entry.address === next.host)) {
        return { ok: false, error: 'Host must be one of the listed interfaces.' };
      }
      // Switching to server mode is allowed before a token exists so the UI can
      // offer "Generate access token"; starting is refused until then.
    }
    const changed =
      next.mode !== currentConfig.mode || next.host !== currentConfig.host;
    // A binding change needs a fresh listener; stop so the new host takes
    // effect and the user explicitly starts again.
    if (changed) await stopCurrent();
    const saved = writeConfig(next);
    return {
      ok: true,
      config: {
        mode: saved.mode,
        host: saved.host,
        tokenRequired: saved.mode === 'server' && Boolean(saved.tokenHash),
        tokenPrefix: saved.tokenPrefix,
        hosts: localHosts(),
      },
    };
  });

  // New token, shown once. Rotating invalidates the old one immediately, so
  // the listener is stopped and must be started again.
  ipcMain.handle('mock:rotate-token', async () => {
    const config = readConfig();
    const token = newToken();
    await stopCurrent();
    const saved = writeConfig({
      ...config,
      tokenHash: hashToken(token),
      tokenPrefix: tokenPrefixOf(token),
    });
    return {
      ok: true,
      token,
      config: {
        mode: saved.mode,
        host: saved.host,
        tokenRequired: Boolean(saved.tokenHash),
        tokenPrefix: saved.tokenPrefix,
        hosts: localHosts(),
      },
    };
  });

  ipcMain.handle('mock:start', async (_event, payload = {}) => {
    // A single server at a time: restarting replaces the previous one.
    await stopCurrent();

    const config = readConfig();
    const mode = config.mode === 'server' ? 'server' : 'local';
    if (mode === 'server' && !config.tokenHash) {
      return { ok: false, error: 'Server mode needs an access token. Generate one first.' };
    }

    const { collections, error } = readCollections(store, payload?.collectionId);
    if (error) return { ok: false, error };

    let started;
    try {
      started = await startMockServer({
        collections,
        port: payload?.port,
        delayMs: payload?.delayMs,
        host: mode === 'server' ? config.host : '127.0.0.1',
        tokenHash: mode === 'server' ? config.tokenHash : '',
      });
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }

    if (!started?.ok) {
      return { ok: false, error: started?.error || 'Failed to start mock server' };
    }

    current = {
      ...started,
      mode,
      host: started.host || (mode === 'server' ? config.host : '127.0.0.1'),
      tokenRequired: Boolean(started.tokenRequired),
      tokenPrefix: config.tokenPrefix,
      urls: displayUrls(mode, started.host || config.host, started.port),
    };
    return {
      ok: true,
      port: started.port,
      url: current.urls[0] || started.url,
      urls: current.urls,
      mode,
      tokenRequired: current.tokenRequired,
      routes: started.getRoutes ? started.getRoutes() : started.routes,
    };
  });

  ipcMain.handle('mock:stop', async () => {
    await stopCurrent();
    return { ok: true };
  });

  ipcMain.handle('mock:status', () => {
    const config = readConfig();
    if (!current) return emptyStatus(config);
    return {
      running: true,
      url: current.urls[0] || current.url,
      urls: current.urls,
      port: current.port,
      mode: current.mode,
      host: current.host,
      tokenRequired: current.tokenRequired,
      tokenPrefix: current.tokenPrefix,
      routes: current.getRoutes ? current.getRoutes() : current.routes,
      logs: current.getLogs(),
    };
  });

  // Apply edited scenarios while the listener (and its port/logs) stays alive.
  ipcMain.handle('mock:reload', (_event, payload = {}) => {
    if (!current) return { ok: false, error: 'Mock server is not running' };
    const collections = Array.isArray(payload?.collections) ? payload.collections : null;
    if (!collections) return { ok: false, error: 'collections must be an array' };
    const routes = current.setRoutes ? current.setRoutes(collections) : [];
    return { ok: true, routes };
  });

  // Runtime-only scenario switch (for demos); persisted manual mode lives in
  // request.mock and is applied with mock:reload. Consumers can also force one
  // scenario per call with `?__scenario=<id>`.
  ipcMain.handle('mock:select', (_event, payload = {}) => {
    if (!current) return { ok: false, error: 'Mock server is not running' };
    const requestId = String(payload?.requestId || '');
    if (!requestId) return { ok: false, error: 'requestId is required' };
    const scenarioId = payload?.scenarioId == null ? null : String(payload.scenarioId);
    const ok = current.selectScenario ? current.selectScenario(requestId, scenarioId) : false;
    return ok
      ? { ok: true, routes: current.getRoutes ? current.getRoutes() : current.routes }
      : { ok: false, error: 'Unknown request or scenario' };
  });
}

export async function stopMockServer() {
  await stopCurrent();
}
