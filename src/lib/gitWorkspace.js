// Git-friendly workspace export/import.
//
// A workspace is written as a folder of small JSON files (one per collection
// and environment) plus a manifest, so diffs stay reviewable in Git. This
// module is pure: no Electron, no filesystem. The main process only moves
// bytes; the renderer owns the format.
//
// Secrets: variable rows with `type === 'secret'` are written as
// `{ key, enabled, type: 'secret' }`. Neither plaintext nor the machine-bound
// `secretEnc` ciphertext ever reaches an exported file — secrets must be
// re-entered after an import.
import { uid } from './factory.js';
import { normalizeCollection, normalizeVariableRows } from './collectionTree.js';
import { migrateToWorkspaces } from './workspace.js';

export const FORMAT = 'relay-workspace';
export const VERSION = 1;
export const MANIFEST_FILE = 'relay-workspace.json';
export const GLOBALS_FILE = 'globals.json';

// Fields that only exist while a request is being edited/sent. They are
// runtime state, never workspace content.
const TRANSIENT_FIELDS = new Set([
  'sending',
  'sendingId',
  'response',
  'testResults',
  'abortController',
]);

export function slugify(name) {
  const slug = String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'item';
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// Secret rows lose their value and ciphertext; everything else is normalized
// so an export is stable regardless of how the row was loaded.
function exportVariables(rows) {
  return normalizeVariableRows(rows).map((row) =>
    row.type === 'secret'
      ? { key: row.key, enabled: row.enabled, type: 'secret' }
      : { key: row.key, value: row.value, enabled: row.enabled, type: row.type }
  );
}

function exportNode(node) {
  if (!node || typeof node !== 'object') return null;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (TRANSIENT_FIELDS.has(key)) continue;
    out[key] = value;
  }
  if (out.type === 'folder') out.items = exportItems(out.items);
  return out;
}

function exportItems(items) {
  return (Array.isArray(items) ? items : []).map(exportNode);
}

function countRequests(items) {
  let count = 0;
  for (const node of Array.isArray(items) ? items : []) {
    if (node?.type === 'folder') count += countRequests(node.items);
    else count += 1;
  }
  return count;
}

function collectionFile(collection) {
  return {
    format: FORMAT,
    id: collection.id,
    name: collection.name || 'Collection',
    description: collection.description || '',
    variables: exportVariables(collection.variables),
    auth: collection.auth ?? null,
    items: exportItems(collection.items),
    // Page destination is shareable; the Confluence token never is.
    confluencePageId: collection.confluencePageId || '',
    confluencePageUrl: collection.confluencePageUrl || '',
    confluenceTitle: collection.confluenceTitle || '',
    confluenceSpaceKey: collection.confluenceSpaceKey || '',
    confluenceParentPageId: collection.confluenceParentPageId || '',
    confluenceSyncedAt: collection.confluenceSyncedAt || null,
    confluenceVersion: collection.confluenceVersion ?? null,
  };
}

function environmentFile(environment) {
  return {
    format: FORMAT,
    id: environment.id,
    name: environment.name || 'Environment',
    variables: exportVariables(environment.variables),
  };
}

/**
 * Build the export file map for a workspace.
 * Returns `{ relativePath: fileContent }`; keys are deterministic, including
 * `relay-workspace.json` first, then collections/environments in their stored
 * order, then `globals.json`.
 */
export function workspaceToFiles(workspace, { generatedAt = null } = {}) {
  const ws = workspace || {};
  const collections = Array.isArray(ws.collections) ? ws.collections : [];
  const environments = Array.isArray(ws.environments) ? ws.environments : [];

  const collectionEntries = collections.map((collection) => {
    const file = `collections/${slugify(collection.name)}-${collection.id}.json`;
    return { file, id: collection.id, name: collection.name || 'Collection' };
  });

  const environmentEntries = environments.map((environment) => {
    const file = `environments/${slugify(environment.name)}-${environment.id}.json`;
    return { file, id: environment.id, name: environment.name || 'Environment' };
  });

  const files = {};

  files[MANIFEST_FILE] = serialize({
    format: FORMAT,
    version: VERSION,
    id: ws.id || null,
    name: ws.name || 'Workspace',
    activeEnvId: ws.activeEnvId ?? null,
    generatedAt: generatedAt ?? ws.generatedAt ?? null,
    counts: {
      collections: collections.length,
      requests: collections.reduce((sum, c) => sum + countRequests(c.items), 0),
      environments: environments.length,
    },
    collections: collectionEntries,
    environments: environmentEntries,
  });

  collections.forEach((collection, index) => {
    files[collectionEntries[index].file] = serialize(collectionFile(collection));
  });

  environments.forEach((environment, index) => {
    files[environmentEntries[index].file] = serialize(environmentFile(environment));
  });

  files[GLOBALS_FILE] = serialize({
    format: FORMAT,
    variables: exportVariables(ws.globals),
  });

  return files;
}

function toFileMap(files) {
  if (files instanceof Map) return Object.fromEntries(files);
  return files && typeof files === 'object' ? files : {};
}

function parseJson(text) {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || !value) return false;
  if (value.includes('\\')) return false;
  if (value.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(value)) return false;
  return value.split('/').every((part) => part && part !== '.' && part !== '..');
}

export function readManifest(files) {
  const map = toFileMap(files);
  const manifest = parseJson(map[MANIFEST_FILE]);
  if (!manifest || manifest.format !== FORMAT) {
    throw new Error('Not a Relay workspace export');
  }
  if (manifest.version !== VERSION) {
    throw new Error(`Unsupported workspace export version: ${manifest.version}`);
  }
  return manifest;
}

/** Parsed manifest for a file map. Throws for missing/invalid manifests. */
export function fileManifest(files) {
  return readManifest(files);
}

// Secret rows come back empty: a shared export must not carry values, and
// machine ciphertext is meaningless on another machine. Non-secret rows keep
// their values.
function importVariables(rows) {
  return normalizeVariableRows(rows).map((row) =>
    row.type === 'secret'
      ? { key: row.key, value: '', enabled: row.enabled, type: 'secret' }
      : { key: row.key, value: row.value, enabled: row.enabled, type: 'default' }
  );
}

function remapItems(items) {
  return (Array.isArray(items) ? items : []).map((node) => {
    if (!node || typeof node !== 'object') return node;
    if (node.type === 'folder') {
      return { ...node, id: uid('fld'), items: remapItems(node.items) };
    }
    return {
      ...node,
      id: uid('req'),
      examples: Array.isArray(node.examples)
        ? node.examples.map((example) => ({
            ...example,
            id: uid('ex'),
            request:
              example?.request && typeof example.request === 'object'
                ? { ...example.request, id: uid('req') }
                : example?.request,
          }))
        : node.examples,
    };
  });
}

/**
 * Parse an exported workspace.
 *
 * Only files named by the manifest (plus the fixed `globals.json`) are read;
 * unknown entries are ignored and unsafe (`..`, absolute) paths are skipped
 * with a warning. Ids colliding with `existingWorkspaceIds` /
 * `existingCollectionIds` are regenerated, including nested item ids, and are
 * reported as `'ids remapped'`.
 */
export function filesToWorkspace(
  files,
  { existingWorkspaceIds = [], existingCollectionIds = [] } = {}
) {
  const map = toFileMap(files);
  const manifest = readManifest(map);
  const warnings = [];

  const existingWorkspaces = new Set(existingWorkspaceIds || []);
  const existingIds = new Set(existingCollectionIds || []);
  const usedIds = new Set(existingIds);
  let remapped = false;
  const markRemapped = () => {
    remapped = true;
  };

  const uniqueId = (prefix) => {
    let id = uid(prefix);
    while (usedIds.has(id)) id = uid(prefix);
    usedIds.add(id);
    return id;
  };

  let workspaceId = typeof manifest.id === 'string' && manifest.id ? manifest.id : '';
  if (!workspaceId) workspaceId = uniqueId('ws');
  if (existingWorkspaces.has(workspaceId)) {
    workspaceId = uniqueId('ws');
    markRemapped();
  }

  const collectionEntries = Array.isArray(manifest.collections) ? manifest.collections : [];
  const collections = [];

  for (const entry of collectionEntries) {
    const file = entry?.file;
    if (!isSafeRelativePath(file)) {
      warnings.push(`Ignored unsafe path: ${file == null ? '' : String(file)}`);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(map, file)) {
      warnings.push(`Missing file: ${file}`);
      continue;
    }
    const json = parseJson(map[file]);
    if (!json || json.format !== FORMAT) {
      warnings.push(`Invalid collection file: ${file}`);
      continue;
    }

    const sourceId = typeof json.id === 'string' && json.id ? json.id : '';
    let id = sourceId || uniqueId('col');
    let collectionRemapped = false;
    if (sourceId && usedIds.has(id)) {
      id = uniqueId('col');
      collectionRemapped = true;
      markRemapped();
    } else if (sourceId) {
      usedIds.add(id);
    }

    const sourceItems = Array.isArray(json.items) ? json.items : [];
    const collection = normalizeCollection({
      id,
      name: json.name || entry?.name || 'Collection',
      description: json.description || '',
      variables: importVariables(json.variables),
      auth: json.auth || undefined,
      items: collectionRemapped ? remapItems(sourceItems) : sourceItems,
      confluencePageId: json.confluencePageId || '',
      confluencePageUrl: json.confluencePageUrl || '',
      confluenceTitle: json.confluenceTitle || '',
      confluenceSpaceKey: json.confluenceSpaceKey || '',
      confluenceParentPageId: json.confluenceParentPageId || '',
      confluenceSyncedAt: json.confluenceSyncedAt || null,
      confluenceVersion: Number.isInteger(json.confluenceVersion) ? json.confluenceVersion : null,
    });
    collections.push(collection);
  }

  const environmentEntries = Array.isArray(manifest.environments) ? manifest.environments : [];
  const environments = [];
  const envIdMap = new Map();

  for (const entry of environmentEntries) {
    const file = entry?.file;
    if (!isSafeRelativePath(file)) {
      warnings.push(`Ignored unsafe path: ${file == null ? '' : String(file)}`);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(map, file)) {
      warnings.push(`Missing file: ${file}`);
      continue;
    }
    const json = parseJson(map[file]);
    if (!json || json.format !== FORMAT) {
      warnings.push(`Invalid environment file: ${file}`);
      continue;
    }

    const originalId = typeof json.id === 'string' && json.id ? json.id : '';
    let id = originalId || uniqueId('env');
    if (originalId && usedIds.has(id)) {
      id = uniqueId('env');
      markRemapped();
    } else if (originalId) {
      usedIds.add(id);
    }
    if (originalId) envIdMap.set(originalId, id);

    environments.push({
      id,
      name: json.name || entry?.name || 'Environment',
      variables: importVariables(json.variables),
    });
  }

  let globals = [];
  if (Object.prototype.hasOwnProperty.call(map, GLOBALS_FILE)) {
    const json = parseJson(map[GLOBALS_FILE]);
    if (!json || json.format !== FORMAT) warnings.push(`Invalid globals file: ${GLOBALS_FILE}`);
    else globals = importVariables(json.variables);
  }

  const activeEnvId =
    manifest.activeEnvId && envIdMap.has(manifest.activeEnvId)
      ? envIdMap.get(manifest.activeEnvId)
      : null;

  const candidate = {
    id: workspaceId,
    name: manifest.name || 'Imported Workspace',
    collections,
    environments,
    globals,
    history: [],
    activeEnvId,
  };

  // Canonicalize through the same normalizer the store uses on load, so an
  // imported workspace is identical to a persisted one.
  const workspace = migrateToWorkspaces({ workspaces: [candidate] }).workspaces[0];

  if (remapped && !warnings.includes('ids remapped')) warnings.push('ids remapped');

  return { workspace, warnings };
}
