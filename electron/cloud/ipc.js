import { CloudError } from './client.js';

// IPC surface for relay-api.
//
// Every handler answers with { ok: true, data } or
// { ok: false, error: { code, message, status } }. Tokens never cross this
// boundary: the client keeps them in main, and only user/workspace payloads
// are returned to the renderer.

export const CLOUD_CHANNELS = [
  'cloud:status',
  'cloud:login',
  'cloud:register',
  'cloud:logout',
  'cloud:workspaces',
  'cloud:create-workspace',
  'cloud:rename-workspace',
  'cloud:delete-workspace',
  'cloud:push',
  'cloud:pull',
  'cloud:devices',
  'cloud:revoke-device',
];

function wireError(err) {
  if (err instanceof CloudError) {
    return { code: err.code, message: err.message, status: err.status || 0 };
  }
  return {
    code: 'internal',
    message: err?.message ? String(err.message) : 'Cloud request failed',
    status: 0,
  };
}

export function registerCloudIpc({ ipcMain, client }) {
  if (!ipcMain) throw new Error('registerCloudIpc requires ipcMain');
  if (!client) throw new Error('registerCloudIpc requires a cloud client');

  for (const channel of CLOUD_CHANNELS) {
    try {
      ipcMain.removeHandler(channel);
    } catch {
      /* handler was not registered */
    }
  }

  const wrap = (run) => async (_event, payload) => {
    try {
      return { ok: true, data: await run(payload ?? {}) };
    } catch (err) {
      return { ok: false, error: wireError(err) };
    }
  };

  ipcMain.handle('cloud:status', wrap(() => client.status()));
  ipcMain.handle('cloud:login', wrap((payload) => client.login(payload)));
  ipcMain.handle('cloud:register', wrap((payload) => client.register(payload)));
  ipcMain.handle('cloud:logout', wrap(() => client.logout()));
  ipcMain.handle('cloud:workspaces', wrap(() => client.listWorkspaces()));
  ipcMain.handle(
    'cloud:create-workspace',
    wrap((payload) => client.createWorkspace(payload.name))
  );
  ipcMain.handle(
    'cloud:rename-workspace',
    wrap((payload) => client.renameWorkspace(payload.id, payload.name))
  );
  ipcMain.handle(
    'cloud:delete-workspace',
    wrap((payload) => client.deleteWorkspace(payload.id))
  );
  ipcMain.handle(
    'cloud:push',
    wrap((payload) => client.pushChanges(payload.workspaceId, payload.changes))
  );
  ipcMain.handle(
    'cloud:pull',
    wrap((payload) =>
      client.pullChanges(payload.workspaceId, { since: payload.since, limit: payload.limit })
    )
  );
  ipcMain.handle('cloud:devices', wrap(() => client.devices()));
  ipcMain.handle('cloud:revoke-device', wrap((payload) => client.revokeDevice(payload.id)));

  return { channels: CLOUD_CHANNELS };
}
