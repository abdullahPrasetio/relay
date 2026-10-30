import { CloudError } from './client.js';
import { WorkspaceKeyError } from './workspace-keys.js';

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
  'cloud:monitors',
  'cloud:create-monitor',
  'cloud:get-monitor',
  'cloud:update-monitor',
  'cloud:delete-monitor',
  'cloud:monitor-runs',
  'cloud:run-monitor',
  'cloud:comments',
  'cloud:create-comment',
  'cloud:update-comment',
  'cloud:delete-comment',
  'cloud:stream-start',
  'cloud:stream-stop',
  'cloud:presence',
  'cloud:crypto-status',
  'cloud:encrypt-secrets',
  'cloud:decrypt-secrets',
];

function wireError(err) {
  if (err instanceof CloudError || err instanceof WorkspaceKeyError) {
    return { code: err.code, message: err.message, status: err.status || 0 };
  }
  return {
    code: 'internal',
    message: err?.message ? String(err.message) : 'Cloud request failed',
    status: 0,
  };
}

export function registerCloudIpc({ ipcMain, client, stream = null, workspaceKeys = null }) {
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
  ipcMain.handle(
    'cloud:logout',
    wrap(async () => {
      const result = await client.logout();
      // Key material is session-scoped: drop cached workspace keys on sign-out.
      workspaceKeys?.reset?.();
      return result;
    })
  );
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

  // Scheduled monitors. The monitor id is opaque to the renderer; only the
  // workspace-scoped list and per-monitor run history cross this boundary.
  ipcMain.handle('cloud:monitors', wrap((payload) => client.monitors(payload.workspaceId)));
  ipcMain.handle(
    'cloud:create-monitor',
    wrap((payload) => client.createMonitor(payload.workspaceId, payload.monitor))
  );
  ipcMain.handle('cloud:get-monitor', wrap((payload) => client.getMonitor(payload.id)));
  ipcMain.handle(
    'cloud:update-monitor',
    wrap((payload) => client.updateMonitor(payload.id, payload.patch))
  );
  ipcMain.handle('cloud:delete-monitor', wrap((payload) => client.deleteMonitor(payload.id)));
  ipcMain.handle(
    'cloud:monitor-runs',
    wrap((payload) => client.monitorRuns(payload.id, { limit: payload.limit }))
  );
  ipcMain.handle('cloud:run-monitor', wrap((payload) => client.runMonitor(payload.id)));

  // Per-request comments. The entity id is the synced request id; pages are
  // cursor-based, and the server re-checks membership and authorship.
  ipcMain.handle(
    'cloud:comments',
    wrap((payload) =>
      client.comments(payload.workspaceId, {
        entityId: payload.entityId,
        before: payload.before,
        limit: payload.limit,
      })
    )
  );
  ipcMain.handle(
    'cloud:create-comment',
    wrap((payload) => client.createComment(payload.workspaceId, payload.comment))
  );
  ipcMain.handle(
    'cloud:update-comment',
    wrap((payload) => client.updateComment(payload.id, payload.patch))
  );
  ipcMain.handle('cloud:delete-comment', wrap((payload) => client.deleteComment(payload.id)));

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

  // End-to-end secret support. Only envelopes and decrypted values cross this
  // boundary; the workspace key and the device private key stay in main.
  const keyManager = () => {
    if (!workspaceKeys) {
      throw new WorkspaceKeyError('unavailable', 'Workspace key manager is unavailable');
    }
    return workspaceKeys;
  };

  ipcMain.handle(
    'cloud:crypto-status',
    wrap(async (payload) => {
      const state = await keyManager().ensure(payload.workspaceId);
      return {
        ready: Boolean(state?.ready),
        version: state?.version ?? null,
        reason: state?.reason ?? null,
      };
    })
  );
  ipcMain.handle(
    'cloud:encrypt-secrets',
    wrap(async (payload) => {
      const envelopes = await keyManager().encrypt(payload.workspaceId, payload.values);
      return { envelopes };
    })
  );
  ipcMain.handle(
    'cloud:decrypt-secrets',
    wrap(async (payload) => {
      const values = await keyManager().decrypt(payload.workspaceId, payload.envelopes);
      return { values };
    })
  );

  return { channels: CLOUD_CHANNELS };
}
