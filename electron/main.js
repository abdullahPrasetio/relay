import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { sendRequest, fetchOAuth2Token } from './request-engine.js';
import { createStore } from './store.js';
import { writeResponseFile } from './response-file.js';
import { createSendContext } from './network-runtime.js';
import { normalizeNetworkSettings, sanitizeNetworkSettings } from '../shared/networkSettings.js';
import { encryptSecret, decryptSecret } from './secret-store.js';
// Script runner runs user scripts here in Node (renderer CSP forbids eval).
// Imported (not require'd from a copied .cjs) so Vite bundles it + its deps
// into main.js, eliminating stale-copy bugs.
import { runScript } from './script-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Friendly app name (menus, About). The data file keeps its original name so
// existing data is preserved across the rename to "Relay".
app.setName('Relay');

// Test-only: isolate persisted data for E2E runs. Set by the Playwright
// launcher; never set in production.
if (process.env.RELAY_TEST_USER_DATA) {
  fs.mkdirSync(process.env.RELAY_TEST_USER_DATA, { recursive: true });
  app.setPath('userData', process.env.RELAY_TEST_USER_DATA);
}

// Persistent store. We keep reading/writing the existing data file under
// whichever userData dir Electron resolves, so no data is lost on rename.
// Prefer the legacy "rest-tamer" folder if it already holds data.
function resolveDataFile() {
  const current = path.join(app.getPath('userData'), 'rest-tamer-data.json');
  const legacyDir = path.join(path.dirname(app.getPath('userData')), 'rest-tamer');
  const legacy = path.join(legacyDir, 'rest-tamer-data.json');
  try {
    // If the legacy file exists and the current one doesn't, use the legacy.
    if (fs.existsSync(legacy) && !fs.existsSync(current)) return legacy;
  } catch {
    /* ignore */
  }
  return current;
}
const store = createStore(resolveDataFile());

// Stored settings -> runtime settings: ciphertext secrets are decrypted here,
// in main, and never cross the IPC boundary back to the renderer.
function getRuntimeNetwork() {
  const stored = normalizeNetworkSettings(store.getNetworkSettings());
  return {
    ...stored,
    proxies: stored.proxies.map((p) => ({ ...p, password: decryptSecret(p.passwordEnc) })),
    clientCertPassphrase: decryptSecret(stored.clientCertPassphraseEnc || ''),
  };
}

let mainWindow = null;

// In-flight sends, keyed by the renderer-generated request id, so the Stop
// button can abort exactly one request.
const inflight = new Map();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1115',
    title: 'Relay',
    webPreferences: {
      // Lock the renderer down: no Node, isolated context, bridge only.
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC surface: the renderer can only call these channels. ----
function registerIpc() {
  // Fire an HTTP request from Node (no browser CORS, full network access).
  // Uses the persistent cookie jar: attaches matching cookies and stores any
  // Set-Cookie from the response.
  ipcMain.handle('http:send', async (_event, payload) => {
    const { request, requestId } = payload || {};
    let ctx;
    try {
      // Bad TLS paths throw here: report them as a failed response, never as
      // an IPC rejection (the UI treats a rejection as a transport crash).
      ctx = createSendContext({ network: getRuntimeNetwork(), request });
    } catch (err) {
      return { ok: false, error: err.message, timeMs: 0 };
    }
    if (requestId) inflight.set(requestId, ctx);
    try {
      const result = await sendRequest(request, {
        ...ctx.options,
        cookieJar: store.getCookieJar(),
      });
      if (result.cookieJar) store.setCookieJar(result.cookieJar);
      return result;
    } finally {
      ctx.cleanup();
      if (requestId) inflight.delete(requestId);
    }
  });

  // Cancel an in-flight request by the id the renderer generated. Unknown ids
  // are not an error: the request may have finished a moment ago.
  ipcMain.handle('http:abort', (_event, requestId) => {
    const ctx = inflight.get(requestId);
    if (!ctx) return false;
    ctx.abort(new Error('Request aborted'));
    return true;
  });

  // A script-side send that also shares the cookie jar.
  const scriptSend = (req) => {
    let ctx;
    try {
      ctx = createSendContext({ network: getRuntimeNetwork(), request: req });
    } catch (err) {
      return Promise.resolve({ ok: false, error: err.message, timeMs: 0 });
    }
    return sendRequest(req, { ...ctx.options, cookieJar: store.getCookieJar() })
      .then((res) => {
        if (res.cookieJar) store.setCookieJar(res.cookieJar);
        return res;
      })
      .finally(() => ctx.cleanup());
  };

  // Run a pre-request or test script in Node and return results + mutated scopes.
  // `send` lets scripts fire ad-hoc HTTP requests (pm.sendRequest).
  ipcMain.handle('script:run', async (_event, payload) =>
    runScript({ ...payload, send: scriptSend })
  );

  // OAuth 2.0 token fetch (client_credentials / password grant).
  ipcMain.handle('oauth2:token', async (_event, cfg) => {
    let ctx;
    try {
      ctx = createSendContext({
        network: getRuntimeNetwork(),
        request: { url: cfg?.accessTokenUrl || '' },
      });
    } catch (err) {
      return { ok: false, error: err.message };
    }
    try {
      return await fetchOAuth2Token(cfg, ctx.options);
    } finally {
      ctx.cleanup();
    }
  });

  // Cookie jar management for the UI.
  ipcMain.handle('cookies:get', async () => store.getCookieJar());
  ipcMain.handle('cookies:clear', async () => {
    store.setCookieJar([]);
    return [];
  });

  // Native file picker for form-data file uploads. Returns file metadata.
  ipcMain.handle('file:pick', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(win, { properties: ['openFile'] });
    if (res.canceled || !res.filePaths.length) return null;
    const filePath = res.filePaths[0];
    let size = 0;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      /* ignore */
    }
    return { filePath, fileName: path.basename(filePath), size };
  });

  // ---- Network settings (main-process owned; secrets encrypted at rest) ----
  ipcMain.handle('network:get', () => sanitizeNetworkSettings(store.getNetworkSettings()));

  // Merge secrets from the incoming edit with the stored ciphertext:
  //  - a new non-empty `password` is encrypted and replaces the stored one
  //  - `clearPassword: true` erases it
  //  - otherwise the previous ciphertext is preserved (blank field = unchanged)
  ipcMain.handle('network:set', (_event, incoming) => {
    const input = incoming && typeof incoming === 'object' ? incoming : {};
    const current = normalizeNetworkSettings(store.getNetworkSettings());

    const nextProxies = (Array.isArray(input.proxies) ? input.proxies : []).map((p) => {
      const prev = current.proxies.find((x) => x.id === p?.id);
      let passwordEnc = prev?.passwordEnc || '';
      if (p?.clearPassword) passwordEnc = '';
      else if (typeof p?.password === 'string' && p.password.length > 0) {
        passwordEnc = encryptSecret(p.password);
      }
      return { ...p, passwordEnc };
    });

    let clientCertPassphraseEnc = current.clientCertPassphraseEnc || '';
    if (input.clearClientCertPassphrase) clientCertPassphraseEnc = '';
    else if (
      typeof input.clientCertPassphrase === 'string' &&
      input.clientCertPassphrase.length > 0
    ) {
      clientCertPassphraseEnc = encryptSecret(input.clientCertPassphrase);
    }

    const next = normalizeNetworkSettings({
      ...input,
      proxies: nextProxies,
      clientCertPassphraseEnc,
    });
    store.setNetworkSettings(next);
    return sanitizeNetworkSettings(next);
  });

  // Save a response body to disk. Payload: { suggestedName, base64?, text? }.
  ipcMain.handle('response:save', async (_event, payload) => {
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showSaveDialog(win, {
      defaultPath: payload?.suggestedName || 'response.bin',
    });
    if (res.canceled || !res.filePath) return { saved: false };
    try {
      writeResponseFile(res.filePath, payload || {});
      return { saved: true, path: res.filePath };
    } catch (err) {
      return { saved: false, error: err.message };
    }
  });

  // Data persistence channels.
  ipcMain.handle('store:get', async () => store.getAll());
  ipcMain.handle('store:set', async (_event, data) => {
    store.setAll(data);
    return true;
  });
}
