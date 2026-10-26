import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { sendRequest, fetchOAuth2Token } from './request-engine.js';
import { createStore } from './store.js';
// Script runner runs user scripts here in Node (renderer CSP forbids eval).
// Imported (not require'd from a copied .cjs) so Vite bundles it + its deps
// into main.js, eliminating stale-copy bugs.
import { runScript } from './script-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Friendly app name (menus, About). The data file keeps its original name so
// existing data is preserved across the rename to "Relay".
app.setName('Relay');

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

let mainWindow = null;

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
  ipcMain.handle('http:send', async (_event, request) => {
    const result = await sendRequest(request, { cookieJar: store.getCookieJar() });
    if (result.cookieJar) store.setCookieJar(result.cookieJar);
    return result;
  });

  // A script-side send that also shares the cookie jar.
  const scriptSend = (req) =>
    sendRequest(req, { cookieJar: store.getCookieJar() }).then((res) => {
      if (res.cookieJar) store.setCookieJar(res.cookieJar);
      return res;
    });

  // Run a pre-request or test script in Node and return results + mutated scopes.
  // `send` lets scripts fire ad-hoc HTTP requests (pm.sendRequest).
  ipcMain.handle('script:run', async (_event, payload) =>
    runScript({ ...payload, send: scriptSend })
  );

  // OAuth 2.0 token fetch (client_credentials / password grant).
  ipcMain.handle('oauth2:token', async (_event, cfg) => fetchOAuth2Token(cfg));

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

  // Data persistence channels.
  ipcMain.handle('store:get', async () => store.getAll());
  ipcMain.handle('store:set', async (_event, data) => {
    store.setAll(data);
    return true;
  });
}
