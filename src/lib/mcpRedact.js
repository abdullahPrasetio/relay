// Secret redaction for the renderer-side MCP action dispatcher.
//
// These helpers are pure and DOM-free: the MCP bridge runs in the renderer,
// where workspace state (including decrypted secret rows) lives, and every
// result handed to the server must be scrubbed before serialization.
//
// Rules:
// - Declared secret variable values are masked wherever they appear in text.
// - Ciphertext keys (`secretEnc`, `tokenEnc`, `passwordEnc`,
//   `clientCertPassphraseEnc`) and `hasPassword` never leave the renderer.
// - Credential fields (auth tokens/passwords, proxy passwords, cookie values)
//   are blanked or reduced to booleans; the raw values are never included.
import { maskSecrets } from '../../packages/core/src/variables.js';
import { collectSecretValues } from './secretVars.js';

/** Longest string an MCP tool result may carry. */
export const MAX_MCP_STRING = 128 * 1024;

const MAX_DEPTH = 12;

// Ciphertext keys are meaningless outside the main process and must never be
// forwarded to an AI client.
const DROPPED_KEYS = new Set([
  'secretEnc',
  'tokenEnc',
  'passwordEnc',
  'clientCertPassphraseEnc',
  'hasPassword',
]);

// Declared auth secrets, relative to the request's `auth` object.
const AUTH_SECRET_PATHS = [
  ['bearer', 'token'],
  ['basic', 'password'],
  ['apikey', 'value'],
  ['oauth1', 'consumerSecret'],
  ['oauth1', 'tokenSecret'],
  ['oauth2', 'clientSecret'],
  ['oauth2', 'accessToken'],
  ['oauth2', 'refreshToken'],
  ['oauth2', 'password'],
  ['oauth2', 'codeVerifier'],
  ['digest', 'password'],
  ['ntlm', 'password'],
  ['awsv4', 'secretKey'],
  ['awsv4', 'sessionToken'],
  ['jwt', 'secret'],
  ['jwt', 'privateKey'],
];

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Plaintext values of every declared secret in a workspace (environment,
 * collection, folder, and global rows), deduplicated and filtered to strings
 * of at least two characters.
 *
 * @param {object|null|undefined} workspace Workspace-shaped state.
 * @param {object|null|undefined} [activeEnv] Resolved active environment; when
 *   omitted, the workspace's `activeEnvId` is used to find it.
 * @returns {string[]} Secret plaintexts safe to feed to `maskSecrets`.
 */
export function secretPool(workspace, activeEnv) {
  if (!workspace || typeof workspace !== 'object') return [];
  const lists = [];

  const env =
    activeEnv ||
    (Array.isArray(workspace.environments)
      ? workspace.environments.find((e) => e && e.id === workspace.activeEnvId)
      : null);
  if (env) lists.push(env.variables);

  if (Array.isArray(workspace.collections)) {
    for (const collection of workspace.collections) {
      if (!collection || typeof collection !== 'object') continue;
      lists.push(collection.variables);
      collectFolderVariables(collection.items, lists);
    }
  }

  lists.push(workspace.globals);

  const seen = new Set();
  const out = [];
  for (const value of collectSecretValues(...lists)) {
    if (typeof value !== 'string' || value.length < 2 || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function collectFolderVariables(items, lists) {
  if (!Array.isArray(items)) return;
  for (const node of items) {
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'folder') {
      lists.push(node.variables);
      collectFolderVariables(node.items, lists);
    }
  }
}

/**
 * Mask known secret values inside a string.
 *
 * @param {string} text Source text.
 * @param {string[]} [secrets] Plaintext secrets to replace with `••••`.
 * @returns {string} Masked text (non-strings pass through unchanged).
 */
export function maskText(text, secrets) {
  return maskSecrets(text, Array.isArray(secrets) ? secrets : []);
}

/**
 * Deep-clone plain JSON-ish data for MCP output: masks every string against
 * `secrets`, drops ciphertext/`hasPassword` keys, and guards cycles/depth.
 * Non-plain objects (Date, Map, ...) are returned as-is.
 *
 * @param {*} value Data to redact.
 * @param {string[]} [secrets] Plaintext secrets to mask.
 * @returns {*} Redacted clone.
 */
export function redactForMcp(value, secrets) {
  return redactValue(value, Array.isArray(secrets) ? secrets : [], new WeakSet(), 0);
}

function redactValue(value, secrets, stack, depth) {
  if (typeof value === 'string') return maskText(value, secrets);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[max-depth]';

  if (Array.isArray(value)) {
    if (stack.has(value)) return '[circular]';
    stack.add(value);
    const out = value.map((entry) => redactValue(entry, secrets, stack, depth + 1));
    stack.delete(value);
    return out;
  }

  if (!isPlainObject(value)) return value;
  if (stack.has(value)) return '[circular]';
  stack.add(value);

  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (DROPPED_KEYS.has(key)) continue;
    out[key] = redactValue(entry, secrets, stack, depth + 1);
  }
  stack.delete(value);
  return out;
}

/**
 * Reduce variable rows for MCP output: secret rows become metadata only
 * (`hasValue`), non-secret rows keep their value, ciphertext is dropped.
 *
 * @param {Array|undefined|null} rows Variable rows.
 * @returns {Array<object>} Redacted rows (empty array for non-array input).
 */
export function redactVariableRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    if (!row || typeof row !== 'object') return row;
    if (row.type === 'secret') {
      return {
        key: row.key,
        type: 'secret',
        enabled: row.enabled,
        hasValue: Boolean(row.value || row.secretEnc),
      };
    }
    return {
      key: row.key,
      value: row.value,
      enabled: row.enabled,
      type: row.type,
    };
  });
}

function blankAuthSecrets(holder) {
  if (!holder || typeof holder !== 'object') return holder;
  const auth = holder.auth;
  if (!auth || typeof auth !== 'object') return holder;
  for (const [sectionName, field] of AUTH_SECRET_PATHS) {
    const section = auth[sectionName];
    if (section && typeof section === 'object') section[field] = '';
  }
  return holder;
}

/**
 * Clone a stored request with auth secrets blanked (`''`) and ciphertext keys
 * removed. Shapes stay stable so callers can patch the result back.
 *
 * @param {object|null|undefined} request Stored request node.
 * @returns {object|null|undefined} Redacted clone.
 */
export function redactRequest(request) {
  if (!request || typeof request !== 'object') return request;
  const clone = redactForMcp(request, []);
  if (!clone || typeof clone !== 'object') return clone;
  blankAuthSecrets(clone);
  return clone;
}

function redactNode(node) {
  if (!node || typeof node !== 'object') return node;
  if (node.type === 'folder') {
    const clone = redactForMcp(node, []);
    clone.variables = redactVariableRows(node.variables);
    clone.items = Array.isArray(node.items) ? node.items.map(redactNode) : [];
    blankAuthSecrets(clone);
    return clone;
  }
  return redactRequest(node);
}

/**
 * Clone a collection for MCP output: variable rows are reduced to metadata,
 * every request/folder node is redacted, and tree structure is preserved.
 *
 * @param {object|null|undefined} collection Stored collection.
 * @returns {object|null|undefined} Redacted clone.
 */
export function redactCollection(collection) {
  if (!collection || typeof collection !== 'object') return collection;
  const clone = redactForMcp(collection, []);
  clone.variables = redactVariableRows(collection.variables);
  clone.items = Array.isArray(collection.items) ? collection.items.map(redactNode) : [];
  blankAuthSecrets(clone);
  return clone;
}

/**
 * Clone a workspace for MCP output: collections, environments, and globals are
 * redacted. Never returns other workspaces.
 *
 * @param {object|null|undefined} workspace Workspace-shaped state.
 * @returns {object|null|undefined} Redacted clone.
 */
export function redactWorkspace(workspace) {
  if (!workspace || typeof workspace !== 'object') return workspace;
  const clone = redactForMcp(workspace, []);
  clone.collections = Array.isArray(workspace.collections)
    ? workspace.collections.map(redactCollection)
    : [];
  clone.environments = Array.isArray(workspace.environments)
    ? workspace.environments.map((env) => {
        if (!env || typeof env !== 'object') return env;
        const envClone = redactForMcp(env, []);
        envClone.variables = redactVariableRows(env.variables);
        return envClone;
      })
    : [];
  clone.globals = redactVariableRows(workspace.globals);
  return clone;
}

/**
 * Redact network settings: proxy passwords and TLS passphrases collapse to
 * booleans, all ciphertext/plaintext credentials are dropped.
 *
 * @param {object|null|undefined} settings Stored/runtime network settings.
 * @returns {object} Redacted clone.
 */
export function redactNetworkSettings(settings) {
  if (!settings || typeof settings !== 'object') return {};
  const clone = redactForMcp(settings, []);
  clone.hasClientCertPassphrase = Boolean(
    settings.clientCertPassphraseEnc || settings.clientCertPassphrase
  );
  clone.proxies = Array.isArray(settings.proxies)
    ? settings.proxies.map((proxy) => {
        if (!proxy || typeof proxy !== 'object') return proxy;
        return {
          id: proxy.id,
          name: proxy.name,
          protocol: proxy.protocol,
          host: proxy.host,
          port: proxy.port,
          username: proxy.username,
          bypass: proxy.bypass,
          hasPassword: Boolean(proxy.passwordEnc || proxy.password),
        };
      })
    : [];
  delete clone.clientCertPassphrase;
  delete clone.clientCertPassphraseEnc;
  delete clone.password;
  delete clone.passwordEnc;
  return clone;
}

/**
 * Redact the cookie jar: values are replaced by `hasValue`.
 *
 * @param {Array|undefined|null} cookies Cookie records.
 * @returns {Array<object>} Redacted cookies (empty array for non-array input).
 */
export function redactCookies(cookies) {
  if (!Array.isArray(cookies)) return [];
  return cookies.map((cookie) => {
    if (!cookie || typeof cookie !== 'object') return cookie;
    return {
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      expires: cookie.expires,
      hasValue: Boolean(cookie.value),
    };
  });
}

/**
 * Final serialization pass for an MCP tool result: mask secrets, drop
 * ciphertext, then truncate every string over `MAX_MCP_STRING`.
 *
 * @param {*} value Tool result data.
 * @param {string[]} [secrets] Plaintext secrets to mask.
 * @returns {*} JSON-safe redacted clone.
 */
export function serializeMcpResult(value, secrets) {
  const clone = redactForMcp(value, secrets);
  return truncateStrings(clone, new WeakSet(), 0);
}

function truncateStrings(value, stack, depth) {
  if (typeof value === 'string') {
    return value.length > MAX_MCP_STRING ? value.slice(0, MAX_MCP_STRING) : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    if (stack.has(value)) return value;
    stack.add(value);
    const out = value.map((entry) => truncateStrings(entry, stack, depth + 1));
    stack.delete(value);
    return out;
  }
  if (!isPlainObject(value)) return value;
  if (stack.has(value)) return value;
  stack.add(value);
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = truncateStrings(entry, stack, depth + 1);
  }
  stack.delete(value);
  return out;
}
