// Local (no-cloud) workspaces: each is an isolated space with its own
// collections, environments, globals, and history. Mirrors Postman's
// personal/local workspaces.
import { uid, newCollection } from './factory.js';
import { normalizeCollection, normalizeVariableRows } from './collectionTree.js';
import { SCHEMA_VERSION } from '../../shared/schema.js';

export { SCHEMA_VERSION };

export function newWorkspace(name = 'New Workspace') {
  return {
    id: uid('ws'),
    name,
    collections: [],
    environments: [],
    globals: [],
    history: [],
    activeEnvId: null,
  };
}

function normalizeWorkspace(ws) {
  const base = newWorkspace(ws.name || 'Workspace');
  return {
    ...base,
    ...ws,
    id: ws.id || base.id,
    collections: (ws.collections || []).map(normalizeCollection),
    environments: (ws.environments || []).map((env) => ({
      ...env,
      variables: normalizeVariableRows(env.variables),
    })),
    globals: normalizeVariableRows(ws.globals),
    history: ws.history || [],
    activeEnvId: ws.activeEnvId ?? null,
  };
}

// Convert any persisted shape into the workspace shape, migrating legacy
// flat data (pre-workspaces) into a single "Default" workspace.
export function migrateToWorkspaces(data) {
  const d = data || {};

  // Already workspace-shaped.
  if (Array.isArray(d.workspaces) && d.workspaces.length) {
    const workspaces = d.workspaces.map(normalizeWorkspace);
    const activeWorkspaceId =
      workspaces.find((w) => w.id === d.activeWorkspaceId)?.id || workspaces[0].id;
    return { schemaVersion: SCHEMA_VERSION, workspaces, activeWorkspaceId };
  }

  // Legacy flat shape -> Default workspace.
  const def = normalizeWorkspace({
    name: 'Default',
    collections: d.collections?.length ? d.collections : [newCollection('My Collection')],
    environments: d.environments || [],
    globals: d.globals || [],
    history: d.history || [],
    activeEnvId: d.activeEnvId ?? null,
  });
  return { schemaVersion: SCHEMA_VERSION, workspaces: [def], activeWorkspaceId: def.id };
}
