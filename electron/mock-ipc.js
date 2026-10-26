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
  for (const channel of ['mock:start', 'mock:stop', 'mock:status']) {
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
      routes: started.routes,
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
      routes: current.routes,
      logs: current.getLogs(),
    };
  });
}

export async function stopMockServer() {
  await stopCurrent();
}
