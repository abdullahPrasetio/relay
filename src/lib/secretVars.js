// Secret variable plumbing for the renderer.
//
// Secret rows live in the persisted store as `{ type: 'secret', value: '',
// secretEnc: <base64 ciphertext> }`. Encryption/decryption happens in the main
// process via Electron safeStorage (see electron/secret-store.js); this module
// only talks to the preload bridge (`window.api`) and never logs values.
//
// Browser-only dev has no bridge: rows keep their plaintext and gain no
// ciphertext. That is a development convenience, not a supported storage mode.
import { secretValues } from './variables.js';

// Read the bridge lazily so tests (and browser dev) can install or remove
// `window.api` after this module is imported.
function bridge() {
  if (typeof window === 'undefined') return null;
  const api = window.api;
  return api && typeof api === 'object' ? api : null;
}

export function isSecretRow(row) {
  return !!row && row.type === 'secret';
}

async function decryptAll(ciphertexts) {
  const api = bridge();
  const fallback = ciphertexts.map(() => '');
  if (!api) return fallback;
  try {
    if (typeof api.decryptSecrets === 'function') {
      const out = await api.decryptSecrets(ciphertexts);
      return ciphertexts.map((_, i) => (typeof out?.[i] === 'string' ? out[i] : ''));
    }
    if (typeof api.decryptSecret === 'function') {
      return await Promise.all(
        ciphertexts.map(async (ciphertext) => {
          try {
            const value = await api.decryptSecret(ciphertext);
            return typeof value === 'string' ? value : '';
          } catch {
            return '';
          }
        })
      );
    }
  } catch {
    /* secure storage unavailable or a decrypt failure: secret stays hidden */
  }
  return fallback;
}

/**
 * Replace `secretEnc` with decrypted plaintext for secret rows.
 * Non-secret rows, and secret rows without ciphertext, are returned untouched.
 * Never throws: an absent/failing bridge degrades the value to ''.
 */
export async function hydrateSecretRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const encrypted = [];
  list.forEach((row, index) => {
    if (isSecretRow(row) && row.secretEnc) encrypted.push(index);
  });
  if (encrypted.length === 0) return list;

  const plaintexts = await decryptAll(encrypted.map((index) => list[index].secretEnc));
  const out = list.slice();
  encrypted.forEach((index, i) => {
    out[index] = { ...out[index], value: plaintexts[i] ?? '' };
  });
  return out;
}

/**
 * Encrypt non-empty secret-row values before persisting.
 * - secret row with plaintext: `secretEnc = encrypt(value)`, `value = ''`
 * - secret row with a blank value: keeps its existing ciphertext (or none)
 * - every other row: returned as-is
 * Encryption failures propagate so the caller can surface the message.
 */
export async function sealSecretRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const api = bridge();
  return Promise.all(
    list.map(async (row) => {
      if (!isSecretRow(row)) return row;
      const value = typeof row.value === 'string' ? row.value : '';
      if (!value) return row;
      // Dev-only: no bridge means no secure storage; keep the plaintext.
      if (!api || typeof api.encryptSecret !== 'function') return row;
      const secretEnc = await api.encryptSecret(value);
      return { ...row, value: '', secretEnc: typeof secretEnc === 'string' ? secretEnc : '' };
    })
  );
}

/** Plaintext values of secret rows across any number of variable lists. */
export function collectSecretValues(...rowLists) {
  const out = [];
  for (const rows of rowLists) out.push(...secretValues(rows));
  return out;
}

// ---- Whole-workspace traversal ----
// Persisted data is workspace-shaped:
//   workspaces[].collections[].variables / items[] (folders recurse)
//   workspaces[].environments[].variables / workspaces[].globals[]
// These helpers are pure: inputs are never mutated and rows that don't need
// work keep their identity.

async function mapItem(item, transform) {
  if (!item || typeof item !== 'object') return item;
  let next = item;
  if (Array.isArray(item.variables)) {
    next = { ...next, variables: await transform(item.variables) };
  }
  if (Array.isArray(item.items)) {
    const items = await Promise.all(item.items.map((child) => mapItem(child, transform)));
    next = { ...next, items };
  }
  return next;
}

async function mapCollection(collection, transform) {
  if (!collection || typeof collection !== 'object') return collection;
  return {
    ...collection,
    variables: Array.isArray(collection.variables)
      ? await transform(collection.variables)
      : collection.variables,
    items: Array.isArray(collection.items)
      ? await Promise.all(collection.items.map((item) => mapItem(item, transform)))
      : collection.items,
  };
}

async function mapWorkspace(workspace, transform) {
  if (!workspace || typeof workspace !== 'object') return workspace;
  return {
    ...workspace,
    collections: Array.isArray(workspace.collections)
      ? await Promise.all(workspace.collections.map((c) => mapCollection(c, transform)))
      : workspace.collections,
    environments: Array.isArray(workspace.environments)
      ? await Promise.all(
          workspace.environments.map(async (env) =>
            env && typeof env === 'object' && Array.isArray(env.variables)
              ? { ...env, variables: await transform(env.variables) }
              : env
          )
        )
      : workspace.environments,
    globals: Array.isArray(workspace.globals)
      ? await transform(workspace.globals)
      : workspace.globals,
  };
}

/**
 * Decrypt every secret row in every workspace (load boundary).
 * No bridge (browser dev) means no-op: plaintext is already there.
 */
export async function hydrateWorkspaceSecrets(workspaces) {
  if (!Array.isArray(workspaces) || !bridge()) return workspaces;
  return Promise.all(workspaces.map((workspace) => mapWorkspace(workspace, hydrateSecretRows)));
}

/**
 * Encrypt every secret row on a deep copy (persistence boundary).
 * No bridge (browser dev) means no-op; the localStorage fallback stays plain.
 * Encryption failures propagate so the caller can skip the write.
 */
export async function sealWorkspaceSecrets(workspaces) {
  if (!Array.isArray(workspaces) || !bridge()) return workspaces;
  return Promise.all(workspaces.map((workspace) => mapWorkspace(workspace, sealSecretRows)));
}

