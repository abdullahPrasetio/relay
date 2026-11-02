import { startMockServer } from './mock-server.js';

// IPC surface for the local mock server.
//
// Wiring contract for the orchestrator (electron/main.js):
//   1. inside registerIpc():
//        registerMockIpc({ ipcMain, store, BrowserWindow });
//   2. on shutdown (before-quit / window-all-closed):
//        await stopMockServer();
// Nothing is broadcast to the renderer: MockServerModal polls mock:status
// while it is open.

let current = null; // { port, url, routes, stop, getLogs }

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

function emptyStatus() {
  return { running: false, url: null, port: null, routes: [], logs: [] };
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

  // Make registration idempotent so a repeated call cannot throw.
  for (const channel of [
    'mock:start',
    'mock:stop',
    'mock:status',
    'mock:reload',
    'mock:select',
  ]) {
    try {
      ipcMain.removeHandler(channel);
    } catch {
      /* handler was not registered */
    }
  }

  ipcMain.handle('mock:start', async (_event, payload = {}) => {
    // A single server at a time: restarting replaces the previous one.
    await stopCurrent();

    const { collections, error } = readCollections(store, payload?.collectionId);
    if (error) return { ok: false, error };

    let started;
    try {
      started = await startMockServer({
        collections,
        port: payload?.port,
        delayMs: payload?.delayMs,
      });
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }

    if (!started?.ok) {
      return { ok: false, error: started?.error || 'Failed to start mock server' };
    }

    current = started;
    return {
      ok: true,
      port: started.port,
      url: started.url,
      routes: started.getRoutes ? started.getRoutes() : started.routes,
    };
  });

  ipcMain.handle('mock:stop', async () => {
    await stopCurrent();
    return { ok: true };
  });

  ipcMain.handle('mock:status', () => {
    if (!current) return emptyStatus();
    return {
      running: true,
      url: current.url,
      port: current.port,
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
  // request.mock and is applied with mock:reload.
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
