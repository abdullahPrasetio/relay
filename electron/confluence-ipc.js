import { encryptSecret, decryptSecret } from './secret-store.js';
import { confluenceBase, publishPage, testConnection } from './confluence-client.js';

// IPC surface for Confluence. The token is write-only from the renderer:
// get-config returns `hasToken`, publish/test resolve the ciphertext here.
// Nothing in this module logs request headers or page bodies.

const AUTH_METHODS = new Set(['cloud', 'pat']);

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitize(config) {
  if (!config) return null;
  return {
    baseUrl: config.baseUrl || '',
    authMethod: config.authMethod || 'cloud',
    email: config.email || '',
    allowInsecureTls: config.allowInsecureTls === true,
    hasToken: Boolean(config.tokenEnc),
  };
}

function normalizeInput(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const base = confluenceBase(raw.baseUrl);
  if (!base.ok) return { ok: false, error: base.error };
  const authMethod = AUTH_METHODS.has(raw.authMethod) ? raw.authMethod : 'cloud';
  const email = str(raw.email);
  if (authMethod === 'cloud' && !email) {
    return { ok: false, error: 'Email is required for Cloud API tokens.' };
  }
  return {
    ok: true,
    value: {
      baseUrl: base.baseUrl,
      authMethod,
      email: authMethod === 'cloud' ? email : '',
      allowInsecureTls: raw.allowInsecureTls === true,
    },
  };
}

function duplicatePageOwner(data, workspaceId, collectionId, pageId) {
  if (!pageId) return null;
  const workspaces = Array.isArray(data?.workspaces) ? data.workspaces : [];
  const workspace = workspaces.find((w) => w.id === workspaceId);
  for (const collection of workspace?.collections || []) {
    if (!collection || collection.id === collectionId) continue;
    if (String(collection.confluencePageId || '') === String(pageId)) return collection;
  }
  return null;
}

export function registerConfluenceIpc({ ipcMain, store, getNetworkSettings }) {
  if (!ipcMain) throw new Error('registerConfluenceIpc requires ipcMain');
  if (!store) throw new Error('registerConfluenceIpc requires the main-process store');

  for (const channel of [
    'confluence:get-config',
    'confluence:set-config',
    'confluence:test',
    'confluence:publish',
  ]) {
    try {
      ipcMain.removeHandler(channel);
    } catch {
      /* handler was not registered */
    }
  }

  ipcMain.handle('confluence:get-config', (_event, workspaceId) => {
    if (!str(workspaceId)) return { ok: false, error: 'workspaceId is required' };
    return { ok: true, config: sanitize(store.getConfluenceConfig(str(workspaceId))) };
  });

  ipcMain.handle('confluence:set-config', (_event, payload) => {
    const input = payload && typeof payload === 'object' ? payload : {};
    const workspaceId = str(input.workspaceId);
    if (!workspaceId) return { ok: false, error: 'workspaceId is required' };

    const normalized = normalizeInput(input);
    if (!normalized.ok) return normalized;

    const current = store.getConfluenceConfig(workspaceId) || {};
    const next = normalized.value;
    const bindingChanged =
      Boolean(current.baseUrl) &&
      (current.baseUrl !== next.baseUrl ||
        current.authMethod !== next.authMethod ||
        (current.email || '') !== next.email);

    let tokenEnc = current.tokenEnc || '';
    try {
      if (input.clearToken === true) tokenEnc = '';
      else if (typeof input.token === 'string' && input.token.length > 0) {
        tokenEnc = encryptSecret(input.token);
      } else if (bindingChanged) {
        // Never reuse a token after changing where it would be sent.
        tokenEnc = '';
      }
    } catch (err) {
      return { ok: false, error: err?.message || 'Secure storage is unavailable.' };
    }

    const saved = {
      ...next,
      tokenEnc,
      updatedAt: new Date().toISOString(),
    };
    store.setConfluenceConfig(workspaceId, saved);
    return { ok: true, config: sanitize(saved) };
  });

  ipcMain.handle('confluence:test', async (_event, workspaceId) => {
    const id = str(workspaceId);
    const config = store.getConfluenceConfig(id);
    if (!config) return { ok: false, error: 'Confluence is not configured for this workspace.' };
    const token = decryptSecret(config.tokenEnc);
    if (!token) return { ok: false, error: 'Confluence token is missing. Save it again.' };
    return testConnection({ config, token, network: getNetworkSettings() });
  });

  ipcMain.handle('confluence:publish', async (_event, payload) => {
    const input = payload && typeof payload === 'object' ? payload : {};
    const workspaceId = str(input.workspaceId);
    if (!workspaceId) return { ok: false, error: 'workspaceId is required' };

    const config = store.getConfluenceConfig(workspaceId);
    if (!config) {
      return { ok: false, code: 'not_configured', error: 'Configure Confluence for this workspace first.' };
    }
    const token = decryptSecret(config.tokenEnc);
    if (!token) {
      return { ok: false, code: 'token_missing', error: 'Confluence token is missing. Save it again.' };
    }

    const pageId = str(input.pageId);
    const owner = duplicatePageOwner(
      store.getAll(),
      workspaceId,
      str(input.collectionId),
      pageId
    );
    if (owner) {
      return {
        ok: false,
        code: 'page_in_use',
        error: `Page ${pageId} is already linked to collection “${owner.name}”.`,
      };
    }

    return publishPage({
      config,
      token,
      pageId,
      title: input.title,
      content: input.content,
      spaceKey: str(input.spaceKey),
      parentPageId: str(input.parentPageId),
      force: input.force === true,
      network: getNetworkSettings(),
    });
  });
}
