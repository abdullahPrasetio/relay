import { CloudError } from './client.js';

// IPC surface for relay-api.
//
// Every handler answers with { ok: true, data } or
// { ok: false, error: { code, message, status } }. Tokens never cross this
// boundary: the client keeps them in main, and only user/workspace payloads
// are returned to the renderer.

export const CLOUD_CHANNELS = [
  'cloud:status',
  'cloud:me',
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
  'cloud:members',
  'cloud:update-member-role',
  'cloud:remove-member',
  'cloud:create-invite',
  'cloud:list-audit',
  'cloud:stream-start',
  'cloud:stream-stop',
  'cloud:presence',
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

export function registerCloudIpc({ ipcMain, client, stream = null }) {
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
  ipcMain.handle('cloud:me', wrap(() => client.me()));
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

  // Team management. Payloads carry ids and roles only; responses are the
  // member/audit payloads from relay-api (invite tokens are returned exactly
  // once, to the renderer that created the invite).
  ipcMain.handle('cloud:members', wrap((payload) => client.members(payload.workspaceId)));
  ipcMain.handle(
    'cloud:update-member-role',
    wrap((payload) =>
      client.updateMemberRole(payload.workspaceId, payload.userId, payload.role)
    )
  );
  ipcMain.handle(
    'cloud:remove-member',
    wrap((payload) => client.removeMember(payload.workspaceId, payload.userId))
  );
  ipcMain.handle(
    'cloud:create-invite',
    wrap((payload) =>
      client.createInvite(payload.workspaceId, {
        role: payload.role,
        expiresInHours: payload.expiresInHours,
      })
    )
  );
  ipcMain.handle(
    'cloud:list-audit',
    wrap((payload) =>
      client.listAudit(payload.workspaceId, { before: payload.before, limit: payload.limit })
    )
  );

  ipcMain.handle('cloud:stream-start', async (event, payload) => {
    if (!stream) {
      return { ok: false, error: { code: 'internal', message: 'change stream unavailable', status: 0 } };
    }
    try {
      const sender = event.sender;
      stream.start(
        payload?.workspaceId,
        (change) => {
          if (!sender.isDestroyed()) sender.send('cloud:change', change);
        },
        (status) => {
          if (!sender.isDestroyed()) sender.send('cloud:stream-status', status);
        }
      );
      return { ok: true, data: null };
    } catch (err) {
      return { ok: false, error: wireError(err) };
    }
  });
  ipcMain.handle('cloud:stream-stop', async () => {
    stream?.stop();
    return { ok: true, data: null };
  });
  ipcMain.handle(
    'cloud:presence',
    wrap((payload) => client.presence(payload.workspaceId, payload.entityId ?? null))
  );

  return { channels: CLOUD_CHANNELS };
}
