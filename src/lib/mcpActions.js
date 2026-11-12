// Renderer-side implementation of every MCP action.
//
// The main process decides *whether* a call may run (token, scope, approval);
// this module decides *how*. It reuses the same pure helpers as the UI so an
// AI client and the desktop app can never drift apart:
//   - collectionTree.js for tree edits
//   - factory.js / workspace.js for entity shapes
//   - runner.js for sends and collection runs
//   - apiDocs.js / confluenceDocs.js / postmanFormat.js for docs and backups
//   - window.api for everything the main process owns (network, mock, cloud…)
//
// Every result passes through `serializeMcpResult`, so declared secret values
// are masked and ciphertext fields are dropped before leaving the app.

import { varsToMap } from '../../packages/core/src/variables.js';
import {
  addFolder,
  addRequest,
  deleteNode,
  duplicateNode,
  findFolder,
  findNodePath,
  findRequestCollection,
  flattenRequests,
  moveNodeBefore,
  moveNodeTo,
  normalizeCollection,
  normalizeVariableRows,
  renameNode,
  updateRequestNode,
} from './collectionTree.js';
import {
  newCollection,
  newEnvironment,
  newRequest,
  normalizeRequest,
} from './factory.js';
import { newWorkspace } from './workspace.js';
import { runCollection } from './runner.js';
import { isGrpcTls } from './protocol.js';
import { collectionToHtml } from './apiDocs.js';
import { collectionToConfluenceStorage } from './confluenceDocs.js';
import {
  fromPostmanCollection,
  fromWorkspaceBackup,
  toPostmanCollection,
  toWorkspaceBackup,
} from './postmanFormat.js';
import {
  mcpPolicyForWorkspace,
  redactCollection,
  redactCookies,
  redactRequest,
  redactVariableRows,
  redactWorkspace,
  resetMcpSensitivityPolicy,
  secretPool,
  serializeMcpResult,
  setMcpSensitivityPolicy,
} from './mcpRedact.js';
import { getActionSpec, helpPayload } from '../../shared/mcpTools.js';

// Protocol sessions outlive a single action call, so they live at module
// scope. `dispose()` (on app unmount) closes whatever is left.
const SESSIONS = new Map();
const MAX_SESSION_EVENTS = 200;

class McpActionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new McpActionError(code, message);
}

function bridge() {
  if (typeof window === 'undefined') return null;
  const api = window.api;
  return api && typeof api === 'object' ? api : null;
}

function newSessionId() {
  return `mcp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// Add or update a key in a variable list, preserving order/enabled flags.
function objToVarList(obj, existing) {
  const list = (existing || []).map((v) => ({ ...v }));
  const seen = new Set();
  for (const v of list) {
    if (v.key in obj) {
      v.value = obj[v.key];
      seen.add(v.key);
    }
  }
  for (const [key, value] of Object.entries(obj)) {
    if (!seen.has(key) && !list.some((v) => v.key === key)) {
      list.push({ key, value, enabled: true });
    }
  }
  return list;
}

function findRequestNode(items, requestId) {
  for (const node of items || []) {
    if (node.type === 'folder') {
      const found = findRequestNode(node.items, requestId);
      if (found) return found;
    } else if (node.id === requestId) {
      return node;
    }
  }
  return null;
}

function mergeRequestPatch(current, patch) {
  const merged = { ...current, ...patch };
  if (patch.body && typeof patch.body === 'object') {
    merged.body = {
      ...(current.body || {}),
      ...patch.body,
      graphql: { ...(current.body?.graphql || {}), ...(patch.body.graphql || {}) },
    };
  }
  if (patch.auth && typeof patch.auth === 'object') {
    const auth = { ...(current.auth || {}), ...patch.auth };
    for (const key of ['bearer', 'basic', 'apikey', 'oauth1', 'oauth2', 'digest', 'ntlm', 'awsv4', 'jwt']) {
      if (patch.auth[key] && typeof patch.auth[key] === 'object') {
        auth[key] = { ...(current.auth?.[key] || {}), ...patch.auth[key] };
      }
    }
    merged.auth = auth;
  }
  if (patch.settings && typeof patch.settings === 'object') {
    merged.settings = { ...(current.settings || {}), ...patch.settings };
  }
  if (patch.mock && typeof patch.mock === 'object') {
    merged.mock = { ...(current.mock || {}), ...patch.mock };
  }
  if (patch.grpc && typeof patch.grpc === 'object') {
    merged.grpc = { ...(current.grpc || {}), ...patch.grpc };
  }
  return normalizeRequest(merged);
}

function grpcPayloadFor(request) {
  const grpc = request?.grpc || {};
  return {
    target: request?.url || '',
    protoPath: grpc.protoPath || '',
    service: grpc.service || '',
    method: grpc.method || '',
    message: grpc.message ?? '{}',
    metadata: Array.isArray(grpc.metadata) ? grpc.metadata : [],
    tls: isGrpcTls(request?.url || ''),
  };
}

function countRequests(items) {
  let count = 0;
  for (const node of items || []) {
    if (node.type === 'folder') count += countRequests(node.items);
    else count += 1;
  }
  return count;
}

function countFolders(items) {
  let count = 0;
  for (const node of items || []) {
    if (node.type === 'folder') {
      count += 1;
      count += countFolders(node.items);
    }
  }
  return count;
}

/**
 * Build the renderer action dispatcher.
 * `store` is the `useStore()` object, `cloud` the `useCloudSync()` object and
 * `appearance` the `useAppearance()` object; `windowApi` is injectable for
 * tests.
 */
export function createMcpActions({ store, cloud, appearance, windowApi = bridge() }) {
  if (!store) throw new Error('createMcpActions requires the store');

  const api = windowApi || {};
  const requireApi = (name) => {
    const fn = api[name];
    if (typeof fn !== 'function') {
      fail('renderer_error', `Relay bridge "${name}" is unavailable.`);
    }
    return fn;
  };

  // ---- workspace helpers ----

  function resolveWorkspace(workspaceId) {
    const list = Array.isArray(store.workspaces) ? store.workspaces : [];
    if (!workspaceId) return store.activeWorkspace || list[0] || null;
    return list.find((w) => w.id === workspaceId) || null;
  }

  function needWorkspace(workspaceId) {
    const workspace = resolveWorkspace(workspaceId);
    if (!workspace) fail('not_found', 'Workspace not found.');
    return workspace;
  }

  function needCollection(workspace, collectionId) {
    const collection = (workspace.collections || []).find((c) => c.id === collectionId);
    if (!collection) fail('not_found', `Collection "${collectionId}" not found.`);
    return collection;
  }

  // Apply a field patch to a workspace, active or not. The active workspace
  // uses the store's field setters; any other workspace is patched in place
  // and never silently activated.
  function writeWorkspace(workspace, patch) {
    if (!workspace) fail('not_found', 'Workspace not found.');
    if (workspace.id === store.activeWorkspaceId) {
      if ('collections' in patch) store.setCollections(patch.collections);
      if ('environments' in patch) store.setEnvironments(patch.environments);
      if ('globals' in patch) store.setGlobals(patch.globals);
      if ('activeEnvId' in patch) store.setActiveEnvId(patch.activeEnvId);
      if ('history' in patch) store.setHistory(patch.history);
      return;
    }
    store.patchWorkspace(workspace.id, patch);
  }

  function appendHistory(workspace, entries) {
    if (!entries.length) return;
    const limit = Number(store.historyLimit) || 100;
    const next = [...entries, ...(workspace.history || [])].slice(0, limit);
    writeWorkspace(workspace, { history: next });
  }

  // Mirror of App.jsx persistRunScopes: fold env-scope writes into globals when
  // no environment is active, then write collection and global scopes back.
  function persistRunScopes(workspace, scopes, collection, environment) {
    const patch = {};
    if (scopes.environment) {
      if (environment) {
        patch.environments = (workspace.environments || []).map((env) =>
          env.id === environment.id
            ? { ...env, variables: objToVarList(scopes.environment, env.variables) }
            : env
        );
      } else {
        for (const [key, value] of Object.entries(scopes.environment)) {
          scopes.globals = scopes.globals || {};
          scopes.globals[key] = value;
        }
      }
    }
    if (collection && scopes.collection) {
      patch.collections = (patch.collections || workspace.collections || []).map((c) =>
        c.id === collection.id
          ? { ...c, variables: objToVarList(scopes.collection, c.variables) }
          : c
      );
    }
    if (scopes.globals) {
      patch.globals = objToVarList(scopes.globals, workspace.globals || []);
    }
    if (Object.keys(patch).length) writeWorkspace(workspace, patch);
  }

  function resolveEnvironment(workspace, environmentId) {
    if (environmentId) {
      const env = (workspace.environments || []).find((e) => e.id === environmentId);
      if (!env) fail('not_found', `Environment "${environmentId}" not found.`);
      return env;
    }
    const activeId = workspace.activeEnvId;
    if (!activeId) return null;
    return (workspace.environments || []).find((e) => e.id === activeId) || null;
  }

  // ---- protocol session helpers ----

  function sessionFor(sessionId) {
    const entry = SESSIONS.get(sessionId);
    if (!entry) fail('not_found', `Unknown session "${sessionId}".`);
    return entry;
  }

  function closeSession(sessionId) {
    const entry = SESSIONS.get(sessionId);
    if (!entry) return;
    SESSIONS.delete(sessionId);
    try {
      entry.cleanup?.();
    } catch {
      /* unsubscribing from a dead bridge is harmless */
    }
    try {
      if (entry.protocol === 'ws') api.wsClose?.({ id: sessionId });
      else if (entry.protocol === 'mqtt') api.mqttClose?.({ id: sessionId });
      else if (entry.protocol === 'socketio') api.socketIoClose?.({ id: sessionId });
      else if (entry.protocol === 'grpc') api.grpcStreamCancel?.(sessionId);
    } catch {
      /* closing an already-closed session is a no-op */
    }
  }

  function bufferEvent(entry, event) {
    entry.seq += 1;
    entry.events.push({ seq: entry.seq, at: Date.now(), event });
    if (entry.events.length > MAX_SESSION_EVENTS) {
      entry.events.shift();
      entry.dropped += 1;
    }
  }

  function startSession(protocol, id) {
    const entry = { protocol, events: [], dropped: 0, seq: 0, cleanup: null };
    SESSIONS.set(id, entry);
    return entry;
  }

  // ---- actions ----

  // Bridge calls return `{ok,error}` envelopes; MCP clients need the failure to
  // surface as `ok:false` on the tool result, not as nested data.
  function assertBridge(result, fallbackCode = 'renderer_error') {
    if (result && typeof result === 'object' && result.ok === false) {
      fail(
        typeof result.code === 'string' && result.code ? result.code : fallbackCode,
        result.error || 'The action failed.'
      );
    }
    return result;
  }

  const handlers = {
    relay_help: {
      // The main process answers `relay_help` without a scope or approval
      // check; this handler only exists so direct invocations stay coherent.
      help: async () => helpPayload(),
    },

    relay_app: {
      info: async () => ({
        activeWorkspaceId: store.activeWorkspaceId,
        workspaces: (store.workspaces || []).map((w) => ({ id: w.id, name: w.name })),
        cloud: {
          signedIn: !!cloud?.signedIn,
          status: cloud?.status || 'local',
          user: cloud?.user ? { id: cloud.user.id, email: cloud.user.email } : null,
        },
      }),
    },

    relay_workspaces: {
      list: async () => ({
        activeWorkspaceId: store.activeWorkspaceId,
        workspaces: (store.workspaces || []).map((w) => ({
          id: w.id,
          name: w.name,
          collectionCount: (w.collections || []).length,
          environmentCount: (w.environments || []).length,
          active: w.id === store.activeWorkspaceId,
        })),
      }),
      get: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        const includeCollections = p.includeCollections !== false;
        const includeEnvironments = p.includeEnvironments !== false;
        const redacted = redactWorkspace(workspace);
        return {
          id: workspace.id,
          name: workspace.name,
          activeEnvId: workspace.activeEnvId ?? null,
          collectionCount: (workspace.collections || []).length,
          environmentCount: (workspace.environments || []).length,
          globals: redactVariableRows(workspace.globals || []),
          ...(includeCollections ? { collections: redacted.collections } : {}),
          ...(includeEnvironments ? { environments: redacted.environments } : {}),
        };
      },
      create: async (p) => {
        const id = store.createWorkspace(p.name);
        return { workspaceId: id, name: p.name };
      },
      rename: async (p) => {
        needWorkspace(p.workspaceId);
        store.renameWorkspace(p.workspaceId, p.name);
        return { workspaceId: p.workspaceId, name: p.name };
      },
      switch: async (p) => {
        needWorkspace(p.workspaceId);
        store.switchWorkspace(p.workspaceId);
        return { activeWorkspaceId: p.workspaceId };
      },
      delete: async (p) => {
        needWorkspace(p.workspaceId);
        if ((store.workspaces || []).length <= 1) {
          fail('conflict', 'You must keep at least one workspace.');
        }
        store.deleteWorkspace(p.workspaceId);
        return { deleted: p.workspaceId };
      },
    },

    relay_collections: {
      list: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        return {
          workspaceId: workspace.id,
          collections: (workspace.collections || []).map((c) => ({
            id: c.id,
            name: c.name,
            description: c.description || '',
            requestCount: countRequests(c.items),
            folderCount: countFolders(c.items),
          })),
        };
      },
      get: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        return redactCollection(needCollection(workspace, p.collectionId));
      },
      create: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        const collection = newCollection(p.name);
        collection.description = p.description || '';
        writeWorkspace(workspace, {
          collections: [...(workspace.collections || []), collection],
        });
        return { collectionId: collection.id, name: collection.name };
      },
      update: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        const current = needCollection(workspace, p.collectionId);
        const next = normalizeCollection({ ...current, ...p.patch, id: current.id });
        writeWorkspace(workspace, {
          collections: (workspace.collections || []).map((c) =>
            c.id === current.id ? next : c
          ),
        });
        return redactCollection(next);
      },
      delete: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        needCollection(workspace, p.collectionId);
        writeWorkspace(workspace, {
          collections: (workspace.collections || []).filter((c) => c.id !== p.collectionId),
        });
        return { deleted: p.collectionId };
      },
      add_folder: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        needCollection(workspace, p.collectionId);
        writeWorkspace(workspace, {
          collections: addFolder(
            workspace.collections || [],
            p.collectionId,
            p.parentFolderId ?? null,
            p.name
          ),
        });
        return { collectionId: p.collectionId, name: p.name };
      },
      rename_node: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        needCollection(workspace, p.collectionId);
        writeWorkspace(workspace, {
          collections: renameNode(workspace.collections || [], p.collectionId, p.nodeId, p.name),
        });
        return { collectionId: p.collectionId, nodeId: p.nodeId, name: p.name };
      },
      delete_node: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        needCollection(workspace, p.collectionId);
        writeWorkspace(workspace, {
          collections: deleteNode(workspace.collections || [], p.collectionId, p.nodeId),
        });
        return { deleted: p.nodeId };
      },
      move_node: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        needCollection(workspace, p.collectionId);
        const collections = workspace.collections || [];
        const next = p.beforeNodeId
          ? moveNodeBefore(collections, p.nodeId, p.beforeNodeId)
          : moveNodeTo(
              collections,
              p.nodeId,
              p.targetCollectionId || p.collectionId,
              p.targetFolderId ?? null
            );
        writeWorkspace(workspace, { collections: next });
        return {
          nodeId: p.nodeId,
          targetCollectionId: p.targetCollectionId || p.collectionId,
          targetFolderId: p.targetFolderId ?? null,
        };
      },
      duplicate_node: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        needCollection(workspace, p.collectionId);
        writeWorkspace(workspace, {
          collections: duplicateNode(workspace.collections || [], p.collectionId, p.nodeId),
        });
        return { duplicated: p.nodeId };
      },
      import_postman: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        let parsed;
        try {
          parsed = typeof p.collection === 'string' ? JSON.parse(p.collection) : p.collection;
        } catch {
          fail('invalid_params', 'collection is not valid JSON.');
        }
        if (!parsed || typeof parsed !== 'object') {
          fail('invalid_params', 'collection must be a Postman collection object.');
        }
        const collection = fromPostmanCollection(parsed);
        const taken = new Set(
          (store.workspaces || []).flatMap((w) => (w.collections || []).map((c) => c.id))
        );
        if (taken.has(collection.id)) collection.id = newCollection(collection.name).id;
        writeWorkspace(workspace, {
          collections: [...(workspace.collections || []), collection],
        });
        return {
          collectionId: collection.id,
          name: collection.name,
          requestCount: countRequests(collection.items),
        };
      },
      export_postman: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        const collection = needCollection(workspace, p.collectionId);
        return { collectionId: collection.id, collection: toPostmanCollection(redactCollection(collection)) };
      },
    },

    relay_requests: {
      list: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        const collections = p.collectionId
          ? [needCollection(workspace, p.collectionId)]
          : workspace.collections || [];
        const requests = [];
        for (const collection of collections) {
          for (const node of flattenRequests(collection)) {
            requests.push({
              id: node.id,
              name: node.name,
              method: node.method,
              url: node.url,
              collectionId: collection.id,
            });
          }
        }
        return { workspaceId: workspace.id, requests };
      },
      get: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        const collections = p.collectionId
          ? [needCollection(workspace, p.collectionId)]
          : workspace.collections || [];
        for (const collection of collections) {
          const node = findRequestNode(collection.items, p.requestId);
          if (node) {
            return { collectionId: collection.id, request: redactRequest(node) };
          }
        }
        fail('not_found', `Request "${p.requestId}" not found.`);
      },
      create: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        needCollection(workspace, p.collectionId);
        const base = newRequest();
        const node = normalizeRequest({
          ...base,
          ...(p.request || {}),
          id: p.request?.id || base.id,
        });
        const result = addRequest(
          workspace.collections || [],
          p.collectionId,
          p.parentFolderId ?? null,
          node
        );
        writeWorkspace(workspace, { collections: result.collections });
        return { requestId: result.node.id, collectionId: p.collectionId };
      },
      update: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        const collections = p.collectionId
          ? [needCollection(workspace, p.collectionId)]
          : workspace.collections || [];
        for (const collection of collections) {
          const node = findRequestNode(collection.items, p.requestId);
          if (!node) continue;
          const next = mergeRequestPatch(node, p.patch || {});
          next.id = node.id;
          writeWorkspace(workspace, {
            collections: updateRequestNode(workspace.collections || [], collection.id, next),
          });
          return { collectionId: collection.id, request: redactRequest(next) };
        }
        fail('not_found', `Request "${p.requestId}" not found.`);
      },
      delete: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        const collections = p.collectionId
          ? [needCollection(workspace, p.collectionId)]
          : workspace.collections || [];
        for (const collection of collections) {
          if (!findRequestNode(collection.items, p.requestId)) continue;
          writeWorkspace(workspace, {
            collections: deleteNode(workspace.collections || [], collection.id, p.requestId),
          });
          return { deleted: p.requestId };
        }
        fail('not_found', `Request "${p.requestId}" not found.`);
      },
      duplicate: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        needCollection(workspace, p.collectionId);
        if (!findRequestNode(needCollection(workspace, p.collectionId).items, p.requestId)) {
          fail('not_found', `Request "${p.requestId}" not found.`);
        }
        writeWorkspace(workspace, {
          collections: duplicateNode(workspace.collections || [], p.collectionId, p.requestId),
        });
        return { duplicated: p.requestId };
      },
    },

    relay_environments: {
      list: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        return {
          workspaceId: workspace.id,
          activeEnvId: workspace.activeEnvId ?? null,
          environments: (workspace.environments || []).map((env) => ({
            id: env.id,
            name: env.name,
            variableCount: (env.variables || []).length,
          })),
        };
      },
      create: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        const env = newEnvironment(p.name);
        env.variables = normalizeVariableRows(p.variables || []);
        writeWorkspace(workspace, {
          environments: [...(workspace.environments || []), env],
        });
        return { environmentId: env.id, name: env.name };
      },
      update: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        const current = (workspace.environments || []).find((e) => e.id === p.environmentId);
        if (!current) fail('not_found', `Environment "${p.environmentId}" not found.`);
        const next = {
          ...current,
          ...(p.name !== undefined ? { name: p.name } : {}),
          ...(p.variables !== undefined
            ? { variables: normalizeVariableRows(p.variables) }
            : {}),
        };
        writeWorkspace(workspace, {
          environments: (workspace.environments || []).map((env) =>
            env.id === current.id ? next : env
          ),
        });
        return { environmentId: next.id, name: next.name };
      },
      delete: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        if (!(workspace.environments || []).some((e) => e.id === p.environmentId)) {
          fail('not_found', `Environment "${p.environmentId}" not found.`);
        }
        const patch = {
          environments: (workspace.environments || []).filter((e) => e.id !== p.environmentId),
        };
        if (workspace.activeEnvId === p.environmentId) patch.activeEnvId = null;
        writeWorkspace(workspace, patch);
        return { deleted: p.environmentId };
      },
      activate: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        const id = p.environmentId === null ? null : p.environmentId;
        if (id && !(workspace.environments || []).some((e) => e.id === id)) {
          fail('not_found', `Environment "${id}" not found.`);
        }
        writeWorkspace(workspace, { activeEnvId: id });
        return { activeEnvId: id };
      },
      set_globals: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        writeWorkspace(workspace, { globals: normalizeVariableRows(p.variables) });
        return { globals: redactVariableRows(normalizeVariableRows(p.variables)) };
      },
    },

    relay_execute: {
      send: async (p) => {
        const workspace = needWorkspace();
        const collection = p.collectionId ? needCollection(workspace, p.collectionId) : null;

        let request;
        let owning = collection;
        if (p.requestId) {
          const collections = collection ? [collection] : workspace.collections || [];
          let found = null;
          for (const candidate of collections) {
            const node = findRequestNode(candidate.items, p.requestId);
            if (node) {
              found = { collection: candidate, request: node };
              break;
            }
          }
          if (!found) fail('not_found', `Request "${p.requestId}" not found.`);
          request = found.request;
          owning = found.collection;
        } else if (p.request) {
          request = normalizeRequest(p.request);
          if (!owning) owning = findRequestCollection(workspace.collections || [], request.id);
        } else {
          fail('invalid_params', 'Provide requestId or request.');
        }

        const environment = resolveEnvironment(workspace, p.environmentId);
        const chain = findNodePath(workspace.collections || [], request.id) || (owning ? [owning] : []);
        const run = await runRequests({
          workspace,
          requests: [request],
          chain,
          environment,
          collection: owning,
          options: {
            saveResponses: true,
            keepVariableValues: p.persistVariables === true,
          },
        });

        if (p.persistVariables) {
          persistRunScopes(workspace, run.scopes, owning, environment);
        }
        if (p.saveHistory) {
          appendHistory(workspace, historyEntries(run.results, request));
        }
        return {
          result: run.results[0] || null,
          summary: run.summary,
          ...(p.persistVariables ? { scopes: run.scopes } : {}),
        };
      },
      run_collection: async (p) => {
        const workspace = needWorkspace();
        const collection = needCollection(workspace, p.collectionId);
        const container = p.folderId ? findFolder(collection, p.folderId) : collection;
        if (!container) fail('not_found', `Folder "${p.folderId}" not found.`);
        const requests = flattenRequests(container);
        const chain = p.folderId
          ? findNodePath(workspace.collections || [], p.folderId) || [collection]
          : [collection];
        const environment = resolveEnvironment(workspace, p.environmentId);

        const run = await runRequests({
          workspace,
          requests,
          chain,
          environment,
          collection,
          options: {
            iterations: p.iterations,
            delayMs: p.delayMs,
            data: p.data,
            stopOnError: p.stopOnError === true,
            retries: p.retries,
            retryDelayMs: p.retryDelayMs,
            saveResponses: p.saveResponses !== false,
            keepVariableValues: p.persistVariables === true,
          },
        });

        if (p.persistVariables) {
          persistRunScopes(workspace, run.scopes, collection, environment);
        }
        return {
          results: run.results,
          summary: run.summary,
          ...(p.persistVariables ? { scopes: run.scopes } : {}),
        };
      },
    },

    relay_protocol: {
      open: async (p) => {
        const config = p.config || {};
        const id = newSessionId();
        const entry = startSession(p.protocol, id);
        const onEvent = (payload) => {
          if (!payload || payload.id !== id) return;
          bufferEvent(entry, payload.event);
        };

        try {
          if (p.protocol === 'ws') {
            entry.cleanup = api.onWsEvent?.(onEvent) || null;
            const result = await requireApi('wsConnect')({
              id,
              url: config.url,
              headers: config.headers,
              protocols: config.protocols,
            });
            if (!result?.ok) fail('protocol_error', result?.error || 'WebSocket connection failed.');
          } else if (p.protocol === 'mqtt') {
            entry.cleanup = api.onMqttEvent?.(onEvent) || null;
            const result = await requireApi('mqttConnect')({
              id,
              url: config.url,
              username: config.username,
              password: config.password,
              clientId: config.clientId,
              keepalive: config.keepalive,
              clean: config.clean,
            });
            if (!result?.ok) fail('protocol_error', result?.error || 'MQTT connection failed.');
          } else {
            entry.cleanup = api.onSocketIoEvent?.(onEvent) || null;
            const result = await requireApi('socketIoConnect')({
              id,
              url: config.url,
              auth: config.auth,
              headers: config.headers,
            });
            if (!result?.ok) fail('protocol_error', result?.error || 'Socket.IO connection failed.');
          }
        } catch (err) {
          closeSession(id);
          throw err;
        }
        return { sessionId: id, protocol: p.protocol };
      },
      send: async (p) => {
        const entry = sessionFor(p.sessionId);
        const payload = p.payload || {};
        let result;
        if (entry.protocol === 'ws') {
          const out =
            payload.type === 'binary'
              ? { id: p.sessionId, base64: payload.base64 || '' }
              : { id: p.sessionId, text: payload.data ?? '' };
          result = await requireApi('wsSend')(out);
        } else if (entry.protocol === 'mqtt') {
          if (payload.op === 'subscribe') {
            result = await requireApi('mqttSubscribe')({
              id: p.sessionId,
              topic: payload.topic,
              qos: payload.qos,
            });
          } else if (payload.op === 'unsubscribe') {
            result = await requireApi('mqttUnsubscribe')({
              id: p.sessionId,
              topic: payload.topic,
            });
          } else {
            result = await requireApi('mqttPublish')({
              id: p.sessionId,
              topic: payload.topic,
              payload: payload.payload,
              qos: payload.qos,
              retain: payload.retain,
            });
          }
        } else if (entry.protocol === 'socketio') {
          result = await requireApi('socketIoEmit')({
            id: p.sessionId,
            event: payload.event,
            args: payload.args,
          });
        } else {
          fail('protocol_error', 'This session does not accept messages.');
        }
        if (!result?.ok) fail('protocol_error', result?.error || 'The session could not send.');
        return { sessionId: p.sessionId, sent: true };
      },
      close: async (p) => {
        sessionFor(p.sessionId);
        closeSession(p.sessionId);
        return { sessionId: p.sessionId, closed: true };
      },
      events: async (p) => {
        const entry = sessionFor(p.sessionId);
        const after = Number(p.after) || 0;
        return {
          sessionId: p.sessionId,
          protocol: entry.protocol,
          latestSeq: entry.seq,
          dropped: entry.dropped,
          events: entry.events.filter((e) => e.seq > after),
        };
      },
      grpc_services: async (p) => {
        const request = p.request || {};
        const grpc = request.grpc || {};
        return requireApi('grpcServices')({
          protoPath: grpc.protoPath,
          reflection: grpc.reflection,
          useReflection: grpc.useReflection,
        });
      },
      grpc_invoke: async (p) => {
        const request = p.request || {};
        return requireApi('grpcInvoke')(grpcPayloadFor(request));
      },
      grpc_stream_start: async (p) => {
        const request = p.request || {};
        const id = newSessionId();
        const entry = startSession('grpc', id);
        entry.cleanup = api.onGrpcEvent?.((payload) => {
          if (!payload || payload.id !== id) return;
          bufferEvent(entry, payload.event);
        }) || null;
        const result = await requireApi('grpcStreamStart')({
          id,
          ...grpcPayloadFor(request),
        });
        if (!result?.ok) {
          closeSession(id);
          fail('protocol_error', result?.error || 'Could not start the gRPC stream.');
        }
        return { sessionId: id };
      },
      grpc_stream_cancel: async (p) => {
        await requireApi('grpcStreamCancel')(p.streamId);
        closeSession(p.streamId);
        return { streamId: p.streamId, cancelled: true };
      },
    },

    relay_mock: {
      status: async () => requireApi('mockStatus')(),
      start: async (p) =>
        assertBridge(
          await requireApi('mockStart')({
            collectionId: p.collectionId,
            port: p.port,
            delayMs: p.delayMs,
          })
        ),
      stop: async () => assertBridge(await requireApi('mockStop')()),
      reload: async (p) => {
        const workspace = needWorkspace();
        const collections = p.collectionId
          ? [needCollection(workspace, p.collectionId)]
          : workspace.collections || [];
        return assertBridge(await requireApi('mockReload')({ collections }));
      },
      select_scenario: async (p) =>
        assertBridge(
          await requireApi('mockSelect')({
            requestId: p.requestId,
            scenarioId: p.scenarioId == null ? null : String(p.scenarioId),
          })
        ),
    },

    relay_confluence: {
      get_config: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        return requireApi('confluenceGetConfig')(workspace.id);
      },
      set_config: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        return assertBridge(
          await requireApi('confluenceSetConfig')({
            workspaceId: workspace.id,
            baseUrl: p.baseUrl,
            authMethod: p.authMethod,
            email: p.email,
            token: p.token,
            allowInsecureTls: p.allowInsecureTls,
          })
        );
      },
      test: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        return assertBridge(await requireApi('confluenceTest')(workspace.id));
      },
      publish: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        const collection = needCollection(workspace, p.collectionId);
        const content = collectionToConfluenceStorage(collection, {
          workspaceName: workspace.name,
          contentMode: p.contentMode,
          contentOrder: p.contentOrder,
        });
        return assertBridge(
          await requireApi('confluencePublish')({
            workspaceId: workspace.id,
            collectionId: collection.id,
            pageId: p.pageId || collection.confluencePageId || '',
            title: p.title || collection.confluenceTitle || collection.name,
            spaceKey: p.spaceKey || collection.confluenceSpaceKey || '',
            parentPageId: p.parentPageId || collection.confluenceParentPageId || '',
            force: p.force === true,
            content,
          })
        );
      },
    },

    relay_cloud: {
      status: async () => ({
        signedIn: !!cloud?.signedIn,
        status: cloud?.status || 'local',
        user: cloud?.user ? { id: cloud.user.id, email: cloud.user.email } : null,
        error: cloud?.error || null,
      }),
      list_workspaces: async () => requireApi('cloud').workspaces(),
      attach: async (p) => cloudAction('attach', p.workspaceId),
      detach: async (p) => cloudAction('detach', p.workspaceId),
      sync: async (p) => cloudAction('syncNow', p.workspaceId),
      members: async (p) => requireApi('cloud').members({ workspaceId: p.workspaceId }),
      invite: async (p) =>
        requireApi('cloud').createInvite({
          workspaceId: p.workspaceId,
          role: p.role,
          expiresInHours: p.expiresInHours,
        }),
      update_member: async (p) =>
        requireApi('cloud').updateMemberRole({
          workspaceId: p.workspaceId,
          userId: p.userId,
          role: p.role,
        }),
      remove_member: async (p) =>
        requireApi('cloud').removeMember({ workspaceId: p.workspaceId, userId: p.userId }),
      audit: async (p) =>
        requireApi('cloud').listAudit({ workspaceId: p.workspaceId, limit: p.limit }),
      devices: async () => requireApi('cloud').devices(),
      revoke_device: async (p) => requireApi('cloud').revokeDevice({ id: p.deviceId }),
      comments: async (p) =>
        requireApi('cloud').comments(p.workspaceId, {
          entityId: p.entityId,
          before: p.before,
          limit: p.limit,
        }),
      create_comment: async (p) =>
        requireApi('cloud').createComment(p.workspaceId, p.comment),
      update_comment: async (p) => requireApi('cloud').updateComment(p.commentId, p.patch),
      delete_comment: async (p) => requireApi('cloud').deleteComment(p.commentId),
      mentions: async (p) =>
        requireApi('cloud').mentions(p.workspaceId, { before: p.before, limit: p.limit }),
      monitors: async (p) => requireApi('cloud').monitors(p.workspaceId),
      create_monitor: async (p) =>
        requireApi('cloud').createMonitor(p.workspaceId, p.monitor),
      get_monitor: async (p) => requireApi('cloud').getMonitor(p.monitorId),
      update_monitor: async (p) => requireApi('cloud').updateMonitor(p.monitorId, p.patch),
      delete_monitor: async (p) => requireApi('cloud').deleteMonitor(p.monitorId),
      run_monitor: async (p) => requireApi('cloud').runMonitor(p.monitorId),
      monitor_runs: async (p) =>
        requireApi('cloud').monitorRuns(p.monitorId, { limit: p.limit }),
    },

    relay_settings: {
      get_network: async () => requireApi('getNetworkSettings')(),
      set_network: async (p) => requireApi('setNetworkSettings')(p.settings),
      get_cookies: async () => redactCookies(await requireApi('getCookies')()),
      set_cookie: async (p) => redactCookies(await requireApi('setCookie')(p.cookie)),
      delete_cookie: async (p) => redactCookies(await requireApi('deleteCookie')(p.identity)),
      clear_cookies: async () => redactCookies(await requireApi('clearCookies')()),
      get_history: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        const limit = Math.max(1, Math.min(1000, Number(p.limit) || 50));
        return {
          workspaceId: workspace.id,
          history: (workspace.history || []).slice(0, limit).map((entry) => ({
            ...entry,
            snapshot: entry?.snapshot ? redactRequest(entry.snapshot) : entry?.snapshot,
          })),
        };
      },
      clear_history: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        writeWorkspace(workspace, { history: [] });
        return { workspaceId: workspace.id, cleared: true };
      },
      get_appearance: async () => {
        if (!appearance?.appearance) fail('renderer_error', 'Appearance is unavailable.');
        return appearance.appearance;
      },
      set_appearance: async (p) => {
        if (!appearance?.update) fail('renderer_error', 'Appearance is unavailable.');
        appearance.update({
          ...(p.mode !== undefined ? { mode: p.mode } : {}),
          ...(p.accent !== undefined ? { accent: p.accent } : {}),
        });
        return { updated: true };
      },
    },

    relay_docs: {
      collection_html: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        const collection = needCollection(workspace, p.collectionId);
        return {
          collectionId: collection.id,
          contentType: 'text/html',
          content: collectionToHtml(collection, {
            workspaceName: workspace.name,
            includeExamples: p.includeExamples !== false,
          }),
        };
      },
      collection_confluence: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        const collection = needCollection(workspace, p.collectionId);
        return {
          collectionId: collection.id,
          contentType: 'text/x-confluence-storage',
          content: collectionToConfluenceStorage(collection, {
            workspaceName: workspace.name,
            includeExamples: p.includeExamples !== false,
            contentMode: p.contentMode,
            contentOrder: p.contentOrder,
          }),
        };
      },
    },

    relay_backup: {
      export_workspace: async (p) => {
        const workspace = needWorkspace(p.workspaceId);
        return {
          workspaceId: workspace.id,
          name: workspace.name,
          backup: toWorkspaceBackup(redactWorkspace(workspace)),
        };
      },
      import_workspace: async (p) => {
        let parsed;
        try {
          parsed = typeof p.backup === 'string' ? JSON.parse(p.backup) : p.backup;
        } catch {
          fail('invalid_params', 'backup is not valid JSON.');
        }
        const restored = fromWorkspaceBackup(parsed);
        if (!restored) fail('invalid_params', 'This is not a Relay workspace backup.');
        const workspace = newWorkspace(restored.name);
        workspace.collections = restored.collections;
        workspace.environments = restored.environments;
        workspace.globals = restored.globals;
        store.importWorkspace(workspace);
        return {
          workspaceId: workspace.id,
          name: workspace.name,
          collectionCount: workspace.collections.length,
        };
      },
    },
  };

  // ---- shared execution helpers ----

  async function runRequests({ workspace, requests, chain, environment, collection, options }) {
    const send = requireApi('sendRequest');
    const runScript =
      typeof api.runScript === 'function' ? (payload) => api.runScript(payload) : null;
    return runCollection({
      requests,
      send: (request, id) => send(request, id),
      runScript,
      environment: varsToMap(environment),
      collection: varsToMap(collection),
      globals: varsToMap(workspace.globals),
      collectionChain: chain,
      shouldStop: null,
      ...options,
    });
  }

  function historyEntries(results, fallbackRequest) {
    const now = Date.now();
    return (results || []).map((result, index) => ({
      id: `h_${now}_${index}`,
      at: new Date().toISOString(),
      method: result.method,
      url: result.url,
      status: result.status,
      ok: result.ok,
      snapshot: fallbackRequest,
      // The runner does not keep the diagnostic "sent" view, and inventing one
      // would be misleading; history shows the request snapshot only.
      sent: null,
    }));
  }

  async function cloudAction(method, workspaceId) {
    if (!cloud || typeof cloud[method] !== 'function') {
      fail('cloud_unavailable', 'Cloud sync requires the Relay desktop app.');
    }
    const result = await cloud[method](workspaceId);
    if (result && result.ok === false) {
      fail('cloud_unavailable', result.error?.message || 'Cloud request failed.');
    }
    return result?.data ?? result ?? null;
  }

  function actionAllowsSensitive(tool, action, params, workspace, policy) {
    if (!policy.secretsAllowed) return false;
    if (policy.allowAll) return true;
    if (!workspace) return false;
    // Workspace reads contain a mix of collections; each collection is
    // pre-redacted by redactWorkspace, so any allowed collection is enough to
    // suppress the final masking pass.
    if (tool === 'relay_workspaces' && action === 'get') {
      return policy.allowedCollections.length > 0;
    }
    if (tool === 'relay_backup' && action === 'export_workspace') {
      return policy.allowedCollections.length > 0;
    }
    if (tool === 'relay_history') return policy.allowedRequests.length > 0;
    if (params?.collectionId) {
      return policy.allowedCollections.includes(params.collectionId);
    }
    if (params?.requestId) {
      const owner = findRequestCollection(workspace.collections || [], params.requestId);
      return Boolean(owner && policy.allowedCollections.includes(owner.id));
    }
    return false;
  }

  async function invoke({ tool, action, params = {}, clientScopes = [] }) {
    const spec = getActionSpec(tool, action);
    if (!spec) {
      return { ok: false, error: { code: 'invalid_params', message: 'Unknown action.' } };
    }
    const group = handlers[tool];
    const handler = group?.[action];
    if (typeof handler !== 'function') {
      return { ok: false, error: { code: 'invalid_params', message: 'Unknown action.' } };
    }
    const workspace = resolveWorkspace(params?.workspaceId);
    const policy = mcpPolicyForWorkspace(workspace);
    policy.secretsAllowed =
      Array.isArray(clientScopes) && clientScopes.includes('secrets');
    setMcpSensitivityPolicy(policy);
    try {
      const data = await handler(params || {});
      const sensitive = actionAllowsSensitive(
        tool,
        action,
        params,
        workspace,
        policy
      );
      return {
        ok: true,
        sensitive,
        data: serializeMcpResult(data, workspace ? secretPool(workspace) : [], {
          allowSensitive: sensitive,
        }),
      };
    } catch (err) {
      const code = err instanceof McpActionError ? err.code : 'renderer_error';
      return { ok: false, error: { code, message: err?.message || String(err) } };
    } finally {
      resetMcpSensitivityPolicy();
    }
  }

  return {
    invoke,
    dispose() {
      for (const id of [...SESSIONS.keys()]) closeSession(id);
    },
  };
}
