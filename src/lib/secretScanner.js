// Heuristic scan for credential-looking values stored under neutral names.
// It only suggests candidates; the user decides whether to mark them secret.
import { isSensitiveKey } from './mcpRedact.js';

const KNOWN_TOKEN_PATTERNS = [
  /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, // JWT
  /^(AKIA|ASIA)[0-9A-Z]{16}$/, // AWS access key
  /^gh[pousr]_[A-Za-z0-9]{20,}$/, // GitHub token
  /^sk_(live|test)_[A-Za-z0-9]{16,}$/, // Stripe secret
  /^xox[baprs]-[A-Za-z0-9-]{10,}$/, // Slack token
  /^[A-Fa-f0-9]{32,}$/, // long hex
];

function entropy(text) {
  const counts = new Map();
  for (const char of text) counts.set(char, (counts.get(char) || 0) + 1);
  let value = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    value -= p * Math.log2(p);
  }
  return value;
}

export function looksLikeSecret(value) {
  const text = String(value ?? '').trim();
  if (text.length < 20 || text.startsWith('{{')) return false;
  if (/^https?:\/\//i.test(text)) return false;
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text)) return false;
  if (KNOWN_TOKEN_PATTERNS.some((pattern) => pattern.test(text))) return true;
  return (
    text.length >= 24 &&
    /[A-Za-z]/.test(text) &&
    /\d/.test(text) &&
    entropy(text) >= 3.5
  );
}

export function maskPreview(value) {
  const text = String(value ?? '');
  if (text.length <= 6) return '••••';
  return `${text.slice(0, 4)}••••${text.slice(-2)}`;
}

function pushCandidates(out, rows, meta) {
  for (const row of rows || []) {
    if (!row || typeof row !== 'object') continue;
    if (row.type === 'secret' || isSensitiveKey(row.key)) continue;
    if (!looksLikeSecret(row.value)) continue;
    out.push({
      id: `${meta.scope}:${meta.environmentId || meta.collectionId || ''}:${
        meta.folderId || ''
      }:${row.key}`,
      scope: meta.scope,
      label: meta.label,
      environmentId: meta.environmentId || null,
      collectionId: meta.collectionId || null,
      folderId: meta.folderId || null,
      key: row.key,
      preview: maskPreview(row.value),
    });
  }
}

function walkFolder(folder, collection, out) {
  pushCandidates(out, folder.variables, {
    scope: 'folder',
    label: `${collection.name} / ${folder.name}`,
    collectionId: collection.id,
    folderId: folder.id,
  });
  for (const child of folder.items || []) {
    if (child.type === 'folder') walkFolder(child, collection, out);
  }
}

export function scanWorkspaceSecrets(workspace) {
  const out = [];
  for (const env of workspace?.environments || []) {
    pushCandidates(out, env.variables, {
      scope: 'environment',
      label: `Environment: ${env.name}`,
      environmentId: env.id,
    });
  }
  pushCandidates(out, workspace?.globals, {
    scope: 'globals',
    label: 'Globals',
  });
  for (const collection of workspace?.collections || []) {
    pushCandidates(out, collection.variables, {
      scope: 'collection',
      label: `Collection: ${collection.name}`,
      collectionId: collection.id,
    });
    for (const item of collection.items || []) {
      if (item.type === 'folder') walkFolder(item, collection, out);
    }
  }
  return out;
}

function markRows(rows, key) {
  return (rows || []).map((row) =>
    row && row.key === key ? { ...row, type: 'secret' } : row
  );
}

function markFolder(folder, folderId, key) {
  if (folder.id === folderId) {
    return { ...folder, variables: markRows(folder.variables, key) };
  }
  return {
    ...folder,
    items: (folder.items || []).map((child) =>
      child.type === 'folder' ? markFolder(child, folderId, key) : child
    ),
  };
}

/** Return a new workspace with the candidate variable marked `type: secret`. */
export function markSecretInWorkspace(workspace, candidate) {
  if (!workspace || !candidate) return workspace;
  const key = candidate.key;
  if (candidate.scope === 'globals') {
    return { ...workspace, globals: markRows(workspace.globals, key) };
  }
  if (candidate.scope === 'environment') {
    return {
      ...workspace,
      environments: (workspace.environments || []).map((env) =>
        env.id === candidate.environmentId
          ? { ...env, variables: markRows(env.variables, key) }
          : env
      ),
    };
  }
  return {
    ...workspace,
    collections: (workspace.collections || []).map((collection) => {
      if (collection.id !== candidate.collectionId) return collection;
      if (candidate.scope === 'collection') {
        return { ...collection, variables: markRows(collection.variables, key) };
      }
      return {
        ...collection,
        items: (collection.items || []).map((item) =>
          item.type === 'folder'
            ? markFolder(item, candidate.folderId, key)
            : item
        ),
      };
    }),
  };
}
