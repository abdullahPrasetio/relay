import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { sendRequest, fetchOAuth2Token } from './request-engine.js';
import {
  authorizeOAuth2,
  getOAuth2Status,
  rememberOAuth2Token,
} from './auth/index.js';
import { createStore } from './store.js';
import { writeResponseFile } from './response-file.js';
import { deleteCookie, pruneExpired, upsertCookie } from './cookie-jar.js';
import { createSendContext } from './network-runtime.js';
import {
  openSession as openWsSession,
  sendFrame as sendWsFrame,
  closeSession as closeWsSession,
  closeAll as closeAllWsSessions,
} from './protocols/websocket.js';
import {
  openSession as openMqttSession,
  publish as publishMqtt,
  subscribe as subscribeMqtt,
  unsubscribe as unsubscribeMqtt,
  closeSession as closeMqttSession,
  closeAll as closeAllMqttSessions,
} from './protocols/mqtt.js';
import {
  openSession as openSocketIoSession,
  emit as emitSocketIo,
  closeSession as closeSocketIoSession,
  closeAll as closeAllSocketIoSessions,
} from './protocols/socketio.js';
import {
  loadServices as loadGrpcServices,
  invokeUnary as invokeGrpcUnary,
  startServerStream as startGrpcStream,
  cancelStream as cancelGrpcStream,
  closeAll as closeAllGrpcStreams,
} from './protocols/grpc.js';
import { normalizeNetworkSettings, sanitizeNetworkSettings } from '../shared/networkSettings.js';
import { SCHEMA_VERSION } from '../shared/schema.js';
import { encryptSecret, decryptSecret } from './secret-store.js';
import { initAutoUpdate } from './updater.js';
import { registerMockIpc, stopMockServer } from './mock-ipc.js';
import { createCloudClient } from './cloud/client.js';
import { createTokenStore } from './cloud/token-store.js';
import { registerCloudIpc } from './cloud/ipc.js';
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

// One-time safety copy of the data file before the renderer migrates it to the
// current schema. Never overwrites an existing backup, and does nothing on a
// fresh install (no file yet).
const storedSchema = Number(store.getAll().schemaVersion) || 1;
if (storedSchema < SCHEMA_VERSION) store.backup(`v${storedSchema}`);

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

// Set once the renderer confirmed it is fine to quit (no unsaved work, or the
// user chose to discard). Until then the close is vetoed so the renderer can
// show a real prompt instead of the window dying silently.
let allowWindowClose = false;

// In-flight sends, keyed by the renderer-generated request id, so the Stop
// button can abort exactly one request.
const inflight = new Map();

// Socket events go only to the focused window. Session ids are renderer
// generated, so a stale event for a closed tab is simply ignored there.
function forwardProtocolEvent(channel, id, event) {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (!win || win.webContents.isDestroyed()) return;
  try {
    win.webContents.send(channel, { id, event });
  } catch {
    /* window went away mid-event */
  }
}

function forwardWsEvent(id, event) {
  forwardProtocolEvent('ws:event', id, event);
}

function forwardMqttEvent(id, event) {
  forwardProtocolEvent('mqtt:event', id, event);
}

function forwardSocketIoEvent(id, event) {
  forwardProtocolEvent('socketio:event', id, event);
}

function forwardGrpcEvent(id, event) {
  forwardProtocolEvent('grpc:event', id, event);
}

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

  // Quit handshake: the renderer decides whether there is unsaved work. It
  // answers through `app:close-confirmed`; a second close request is harmless.
  mainWindow.on('close', (event) => {
    if (allowWindowClose || !mainWindow || mainWindow.webContents.isDestroyed()) return;
    event.preventDefault();
    mainWindow.webContents.send('app:close-requested');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    allowWindowClose = false;
  });
}

app.whenReady().then(() => {
  // Cloud client: one instance for the app's lifetime. The refresh token is
  // persisted encrypted in userData; the access token never leaves memory.
  const cloudClient = createCloudClient({
    baseUrl: process.env.RELAY_API_URL || 'http://127.0.0.1:8080',
    tokenStore: createTokenStore(),
  });
  registerCloudIpc({ ipcMain, client: cloudClient });

  registerIpc();
  createWindow();

  // Best-effort; no-op in dev and when RELAY_DISABLE_UPDATER=1.
  initAutoUpdate({ app, dialog }).catch((err) => {
    console.error('[updater] initialization failed:', err?.message || err);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Sockets belong to the app, not to a single renderer; never leave them
  // running after the last window is gone.
  closeAllWsSessions();
  closeAllMqttSessions();
  closeAllSocketIoSessions();
  closeAllGrpcStreams();
  stopMockServer();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  closeAllWsSessions();
  closeAllMqttSessions();
  closeAllSocketIoSessions();
  closeAllGrpcStreams();
  stopMockServer();
});

// ---- Git-friendly workspace export/import file helpers. ----
// The renderer owns the workspace format; main only validates paths and moves
// bytes. Paths are always relative to a user-chosen folder.
const WORKSPACE_EXPORT_MAX_FILES = 200;
const WORKSPACE_EXPORT_MAX_FILE_BYTES = 2 * 1024 * 1024;

function safeExportDirName(name) {
  const cleaned = String(name || 'relay-workspace')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'relay-workspace';
  return cleaned;
}

// Convert a renderer-supplied relative path to OS segments, rejecting
// traversal and absolute paths. Returns null when unsafe.
function workspaceRelativePath(relative) {
  if (typeof relative !== 'string' || !relative) return null;
  const normalized = relative.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return null;
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return parts.join(path.sep);
}

// ---- IPC surface: the renderer can only call these channels. ----
function registerIpc() {
  // Local mock server (collection + saved examples) — start/stop/status IPC.
  registerMockIpc({ ipcMain, store, BrowserWindow });

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

  // Token requests use a fresh send context per call so the configured proxy,
  // TLS material and timeout apply without holding a timer across the whole
  // authorization flow.
  const tokenFetcher = async (cfg) => {
    let ctx;
    try {
      ctx = createSendContext({
        network: getRuntimeNetwork(),
        request: { url: cfg?.accessTokenUrl || cfg?.authUrl || '' },
      });
    } catch (err) {
      return { ok: false, error: err.message };
    }
    try {
      return await fetchOAuth2Token(cfg, ctx.options);
    } finally {
      ctx.cleanup();
    }
  };

  // OAuth 2.0 token fetch (client_credentials / password / refresh_token).
  ipcMain.handle('oauth2:token', async (_event, cfg) => {
    const result = await tokenFetcher(cfg);
    if (result.ok) rememberOAuth2Token(cfg, result);
    return result;
  });

  // Full authorization-code + PKCE flow. Opens the system browser and listens
  // on 127.0.0.1 for the redirect. Tokens stay in the main process cache; the
  // renderer only receives the token result to store what the user chose.
  ipcMain.handle('oauth2:authorize', async (_event, cfg) =>
    authorizeOAuth2(cfg, {
      openBrowser: (url) => shell.openExternal(url),
      fetcher: tokenFetcher,
    })
  );

  // Token status for the UI; never returns the token itself.
  ipcMain.handle('oauth2:status', async (_event, cfg) => getOAuth2Status(cfg));

  // Cookie jar management for the UI.
  ipcMain.handle('cookies:get', async () => store.getCookieJar());
  ipcMain.handle('cookies:clear', async () => {
    store.setCookieJar([]);
    return [];
  });
  // Insert or replace a manually entered cookie; expired cookies are pruned
  // first so the table never shows stale rows. Returns the new jar.
  ipcMain.handle('cookies:set', async (_event, cookie) => {
    const jar = upsertCookie(pruneExpired(store.getCookieJar()), cookie);
    store.setCookieJar(jar);
    return jar;
  });
  // Delete by name+domain+path. Returns the new jar.
  ipcMain.handle('cookies:delete', async (_event, identity) => {
    const jar = deleteCookie(pruneExpired(store.getCookieJar()), identity);
    store.setCookieJar(jar);
    return jar;
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

  // ---- Secret variables (safeStorage-backed, values never logged) ----
  // Encrypt one plaintext value. Rejects when secure storage is unavailable so
  // the renderer can show the message and leave the store untouched.
  ipcMain.handle('secrets:encrypt', (_event, value) =>
    typeof value === 'string' ? encryptSecret(value) : ''
  );

  // Decrypt one ciphertext; failures degrade to '' (the secret is unavailable,
  // not an error the UI needs to act on).
  ipcMain.handle('secrets:decrypt', (_event, encoded) =>
    typeof encoded === 'string' ? decryptSecret(encoded) : ''
  );

  // Decrypt a whole environment in one round-trip, preserving order.
  ipcMain.handle('secrets:decryptMany', (_event, encodedList) =>
    (Array.isArray(encodedList) ? encodedList : []).map((encoded) =>
      typeof encoded === 'string' ? decryptSecret(encoded) : ''
    )
  );

  // ---- WebSocket sessions (main-process owned) ----
  // The renderer supplies the session id and receives every event through
  // 'ws:event'. Connect failures are returned as data, never as an IPC
  // rejection, so the panel can show a banner instead of crashing.
  ipcMain.handle('ws:connect', async (_event, payload) => {
    const { id, url, headers, protocols } = payload || {};
    try {
      await openWsSession({
        id,
        url,
        headers,
        protocols,
        onEvent: (event) => forwardWsEvent(id, event),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('ws:send', async (_event, payload) => {
    const { id, text, base64 } = payload || {};
    try {
      if (base64 !== undefined && text === undefined) {
        await sendWsFrame(id, { base64 });
      } else {
        await sendWsFrame(id, { text });
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('ws:close', async (_event, payload) => {
    const { id, code, reason } = payload || {};
    return closeWsSession(id, code, reason);
  });

  // ---- MQTT sessions (main-process owned) ----
  // Same contract as WebSocket: session id from the renderer, events through
  // 'mqtt:event', failures returned as data instead of IPC rejections.
  ipcMain.handle('mqtt:connect', async (_event, payload) => {
    const { id, url, username, password, clientId, keepalive, clean } = payload || {};
    try {
      await openMqttSession({
        id,
        url,
        username,
        password,
        clientId,
        keepalive,
        clean,
        onEvent: (event) => forwardMqttEvent(id, event),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('mqtt:publish', async (_event, payload) => {
    const { id, topic, payload: body, base64, qos, retain } = payload || {};
    try {
      const ok = await publishMqtt(id, { topic, payload: body, base64, qos, retain });
      return ok ? { ok: true } : { ok: false, error: 'MQTT session is not open' };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('mqtt:subscribe', async (_event, payload) => {
    const { id, topic, qos } = payload || {};
    try {
      const ok = await subscribeMqtt(id, { topic, qos });
      return ok ? { ok: true } : { ok: false, error: 'MQTT session is not open' };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('mqtt:unsubscribe', async (_event, payload) => {
    const { id, topic } = payload || {};
    try {
      const ok = await unsubscribeMqtt(id, topic);
      return ok ? { ok: true } : { ok: false, error: 'MQTT session is not open' };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('mqtt:close', async (_event, payload) => {
    const { id } = payload || {};
    return closeMqttSession(id);
  });

  // ---- Socket.IO sessions (main-process owned) ----
  ipcMain.handle('socketio:connect', async (_event, payload) => {
    const { id, url, auth, headers } = payload || {};
    try {
      await openSocketIoSession({
        id,
        url,
        auth,
        headers,
        onEvent: (event) => forwardSocketIoEvent(id, event),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('socketio:emit', async (_event, payload) => {
    const { id, event, args } = payload || {};
    try {
      const ok = await emitSocketIo(id, event, args);
      return ok ? { ok: true } : { ok: false, error: 'Socket.IO session is not open' };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('socketio:close', async (_event, payload) => {
    const { id } = payload || {};
    return closeSocketIoSession(id);
  });

  // ---- gRPC calls (main-process owned) ----
  // Every handler returns a result object, including failures; nothing here
  // rejects. Stream events go only to the focused window as 'grpc:event'.
  ipcMain.handle('grpc:services', async (_event, payload) => {
    const { protoPath, reflection, useReflection } = payload || {};
    return loadGrpcServices({ protoPath, reflection, useReflection });
  });

  ipcMain.handle('grpc:invoke', async (_event, payload) => {
    const { target, protoPath, service, method, message, metadata, tls, reflection } =
      payload || {};
    return invokeGrpcUnary({
      target,
      protoPath,
      service,
      method,
      message,
      metadata,
      tls,
      reflection,
    });
  });

  ipcMain.handle('grpc:stream', async (_event, payload) => {
    const { id, target, protoPath, service, method, message, metadata, tls } = payload || {};
    return startGrpcStream({
      id,
      target,
      protoPath,
      service,
      method,
      message,
      metadata,
      tls,
      onEvent: (event) => forwardGrpcEvent(id, event),
    });
  });

  ipcMain.handle('grpc:cancel', async (_event, id) => cancelGrpcStream(id));

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

  // Export a workspace as a Git-friendly folder (one file per collection).
  ipcMain.handle('workspace:export', async (_event, payload) => {
    const { files, suggestedName } = payload || {};
    if (!files || typeof files !== 'object') return { ok: false, error: 'No files to export' };
    const entries = Object.entries(files);
    if (entries.length > WORKSPACE_EXPORT_MAX_FILES) {
      return { ok: false, error: `Too many files (max ${WORKSPACE_EXPORT_MAX_FILES})` };
    }

    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };

    try {
      const root = path.join(res.filePaths[0], safeExportDirName(suggestedName));
      let count = 0;
      for (const [relative, content] of entries) {
        const safe = workspaceRelativePath(relative);
        if (!safe) continue; // never write outside the chosen folder
        const target = path.join(root, safe);
        if (!target.startsWith(`${root}${path.sep}`)) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, typeof content === 'string' ? content : String(content ?? ''));
        count += 1;
      }
      return { ok: true, dir: root, count };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Read an exported workspace folder: manifest plus the files it references.
  ipcMain.handle('workspace:import', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };

    const root = res.filePaths[0];
    try {
      let manifest;
      try {
        const raw = fs.readFileSync(path.join(root, 'relay-workspace.json'), 'utf8');
        manifest = JSON.parse(raw);
      } catch {
        return { ok: false, error: 'Not a Relay workspace export' };
      }
      if (!manifest || manifest.format !== 'relay-workspace') {
        return { ok: false, error: 'Not a Relay workspace export' };
      }

      const wanted = new Set(['relay-workspace.json', 'globals.json']);
      for (const entry of Array.isArray(manifest.collections) ? manifest.collections : []) {
        if (typeof entry?.file === 'string') wanted.add(entry.file);
      }
      for (const entry of Array.isArray(manifest.environments) ? manifest.environments : []) {
        if (typeof entry?.file === 'string') wanted.add(entry.file);
      }
      if (wanted.size > WORKSPACE_EXPORT_MAX_FILES) {
        return { ok: false, error: `Too many files (max ${WORKSPACE_EXPORT_MAX_FILES})` };
      }

      const files = {};
      for (const relative of wanted) {
        const safe = workspaceRelativePath(relative);
        if (!safe) continue; // ignore traversal entries, never read them
        const target = path.join(root, safe);
        if (!target.startsWith(`${root}${path.sep}`)) continue;
        let stat;
        try {
          stat = fs.statSync(target);
        } catch {
          continue; // the renderer reports missing files as warnings
        }
        if (!stat.isFile()) continue;
        if (stat.size > WORKSPACE_EXPORT_MAX_FILE_BYTES) {
          return { ok: false, error: `File too large (max 2 MB): ${relative}` };
        }
        files[relative.replace(/\\/g, '/')] = fs.readFileSync(target, 'utf8');
      }

      return { ok: true, files };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // The renderer finished its unsaved-work prompt and allows the close.
  ipcMain.handle('app:close-confirmed', () => {
    allowWindowClose = true;
    // `mainWindow.close()` alone leaves the process alive on macOS (no
    // window-all-closed quit), which makes quit look hung. This is a
    // single-window app: an explicit close means quit.
    app.quit();
    return true;
  });

  // Data persistence channels.
  ipcMain.handle('store:get', async () => store.getAll());
  ipcMain.handle('store:set', async (_event, data) => {
    store.setAll(data);
    return true;
  });
}
