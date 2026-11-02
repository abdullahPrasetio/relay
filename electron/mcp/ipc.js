// IPC surface for MCP settings plus the renderer answer channels.
//
// The renderer can configure the server and manage clients, but it can never
// read a token back: `mcp:get-config` returns the sanitized config only, and a
// raw token is returned exactly once by create/rotate.

import { sanitizeMcpConfig } from './config.js';

const SETTINGS_CHANNELS = [
  'mcp:get-config',
  'mcp:status',
  'mcp:set-enabled',
  'mcp:set-port',
  'mcp:create-client',
  'mcp:update-client',
  'mcp:revoke-client',
  'mcp:rotate-token',
];

export function registerMcpIpc({ ipcMain, mcp, getWindow, bridgePath }) {
  if (!ipcMain) throw new Error('registerMcpIpc requires ipcMain');
  if (!mcp) throw new Error('registerMcpIpc requires the MCP runtime');
  if (!bridgePath) throw new Error('registerMcpIpc requires the stdio bridge path');

  for (const channel of SETTINGS_CHANNELS) {
    try {
      ipcMain.removeHandler(channel);
    } catch {
      /* handler was not registered */
    }
  }
  ipcMain.removeAllListeners('mcp:invoke-result');
  ipcMain.removeAllListeners('mcp:approval-result');

  // Only the main window's top frame may answer a forwarded call or approval.
  function fromMainFrame(event) {
    const win = typeof getWindow === 'function' ? getWindow() : null;
    if (!win || win.isDestroyed?.()) return false;
    const frame = win.webContents?.mainFrame;
    return !!frame && event.senderFrame === frame;
  }

  ipcMain.handle('mcp:get-config', () => {
    const config = sanitizeMcpConfig(mcp.getConfig());
    const status = mcp.status();
    return {
      ...config,
      status,
      // The URL is advertised even while stopped so the client config can be
      // prepared before the listener starts.
      httpUrl: status.url || `http://127.0.0.1:${config.port}/mcp`,
      stdio: {
        command: process.execPath,
        args: [bridgePath],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
    };
  });

  ipcMain.handle('mcp:status', () => mcp.status());

  ipcMain.handle('mcp:set-enabled', (_event, enabled) => mcp.setEnabled(enabled === true));

  ipcMain.handle('mcp:set-port', (_event, port) => mcp.setPort(port));

  ipcMain.handle('mcp:create-client', (_event, payload) =>
    mcp.createClient(payload && typeof payload === 'object' ? payload : {})
  );

  ipcMain.handle('mcp:update-client', (_event, payload) =>
    mcp.updateClient(payload && typeof payload === 'object' ? payload : {})
  );

  ipcMain.handle('mcp:revoke-client', (_event, id) =>
    mcp.revokeClient(typeof id === 'string' ? id : '')
  );

  ipcMain.handle('mcp:rotate-token', (_event, id) =>
    mcp.rotateToken(typeof id === 'string' ? id : '')
  );

  ipcMain.on('mcp:invoke-result', (event, payload) => {
    if (!fromMainFrame(event)) return;
    if (!payload || typeof payload !== 'object') return;
    mcp.resolveCall(payload);
  });

  ipcMain.on('mcp:approval-result', (event, payload) => {
    if (!fromMainFrame(event)) return;
    if (!payload || typeof payload !== 'object') return;
    mcp.resolveApproval(payload);
  });
}
