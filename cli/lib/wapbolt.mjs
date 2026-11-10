// Convert Wapbolt Local's SQLite rows into Relay workspaces.
//
// Wapbolt keeps collections/folders/requests as rows with JSON columns; Relay
// keeps the same tree inline. This module is pure — the CLI reads SQLite and
// writes the workspace export files, so the mapping is testable without a DB.
//
// Fidelity boundaries:
// - Wapbolt body_variants, extraction_rules and schema_assertions have no Relay
//   equivalent; they are counted as warnings instead of being silently dropped.
// - Histories and comments are runtime/user activity, not workspace content.
// - Wapbolt does not mark secrets, so variable values are kept as default rows.
import { newAuth, newBody, newCollection, newRequest } from '../../src/lib/factory.js';
import { newFolder, normalizeCollection } from '../../src/lib/collectionTree.js';
import { normalizeFieldValidations } from '../../src/lib/fieldValidations.js';

const str = (value) => (value == null ? '' : String(value));

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rowsOf(value) {
  return Array.isArray(value) ? value : [];
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function deletedIds(syncRows) {
  const out = {
    collection: new Set(),
    folder: new Set(),
    request: new Set(),
    environment: new Set(),
    example: new Set(),
  };
  for (const row of rowsOf(syncRows)) {
    if (!row || !row.deleted_at) continue;
    const set = out[row.entity];
    if (set) set.add(num(row.local_id));
  }
  return out;
}

function convertAuth(value, warn) {
  const cfg = parseJson(value, {});
  const type = isRecord(cfg) ? str(cfg.type).trim() : '';
  const base = newAuth();
  if (!type || type === 'No Auth') return { ...base, type: 'none' };
  if (type === 'Inherit') return { ...base, type: 'inherit' };
  if (type === 'Bearer Token') {
    return { ...base, type: 'bearer', bearer: { ...base.bearer, token: str(cfg.token) } };
  }
  if (type === 'Basic Auth') {
    return {
      ...base,
      type: 'basic',
      basic: {
        ...base.basic,
        username: str(cfg.username),
        password: str(cfg.password),
      },
    };
  }
  if (type === 'API Key') {
    return {
      ...base,
      type: 'apikey',
      apikey: {
        ...base.apikey,
        key: str(cfg.key),
        value: str(cfg.value),
        addTo: cfg.addTo === 'query' ? 'query' : 'header',
      },
    };
  }
  warn(`Unsupported auth type "${type}" was imported as No Auth.`);
  return { ...base, type: 'none' };
}

function convertHeaderRows(value) {
  const obj = parseJson(value, {});
  if (!isRecord(obj)) return [];
  const out = [];
  for (const [key, raw] of Object.entries(obj)) {
    const values = Array.isArray(raw) ? raw : [raw];
    for (const item of values) {
      out.push({ key, value: stringValue(item), enabled: true });
    }
  }
  return out;
}

function headerValue(rows, name) {
  const wanted = String(name).toLowerCase();
  const hit = rows.find((row) => String(row.key).toLowerCase() === wanted);
  return hit ? hit.value : '';
}

// Split a raw URL into Relay's base URL + params list. Components are decoded
// once so Relay's URLSearchParams re-encoding does not double-encode values.
function splitUrl(raw) {
  const source = str(raw);
  const qIndex = source.indexOf('?');
  if (qIndex < 0) return { url: source, params: [] };
  const hashIndex = source.indexOf('#', qIndex);
  const query = source.slice(qIndex + 1, hashIndex < 0 ? undefined : hashIndex);
  const fragment = hashIndex < 0 ? '' : source.slice(hashIndex);
  const decode = (text) => {
    try {
      return decodeURIComponent(text.replace(/\+/g, ' '));
    } catch {
      return text;
    }
  };
  const params = query
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=');
      return eq < 0
        ? { key: decode(pair), value: '', enabled: true }
        : { key: decode(pair.slice(0, eq)), value: decode(pair.slice(eq + 1)), enabled: true };
    });
  return { url: source.slice(0, qIndex) + fragment, params };
}

function rawBodyText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if (
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      typeof value.raw === 'string'
    ) {
      return value.raw;
    }
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

function formRows(value, { fileSupport = false } = {}) {
  const parsed = parseJson(value, value);
  const rows = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.array)
      ? parsed.array
      : [];
  return rows
    .filter((row) => isRecord(row))
    .map((row) => {
      if (fileSupport && row.type === 'file') {
        const filePath = str(row.value);
        return {
          key: str(row.key),
          type: 'file',
          filePath,
          fileName: filePath.split(/[\\/]/).pop() || '',
          contentType: '',
          enabled: row.enabled !== false,
        };
      }
      return {
        key: str(row.key),
        value: str(row.value),
        type: 'text',
        enabled: row.enabled !== false,
      };
    });
}

function convertBody(value, bodyType, warn) {
  const type = str(bodyType);
  const base = newBody();
  if (!type || type === 'none') return base;

  if (type === 'x-www-form-urlencoded' || type === 'form-data') {
    return {
      ...base,
      mode: type === 'form-data' ? 'form-data' : 'form-urlencoded',
      form: formRows(value, { fileSupport: type === 'form-data' }),
    };
  }

  if (type.startsWith('raw-')) {
    const language = type.slice(4);
    return {
      ...base,
      mode: language === 'json' ? 'json' : 'raw',
      raw: rawBodyText(parseJson(value, value)),
    };
  }

  if (type === 'graphql') {
    const parsed = parseJson(value, value);
    const gql = isRecord(parsed) ? parsed : {};
    return {
      ...base,
      mode: 'graphql',
      graphql: {
        query: str(gql.query ?? (typeof parsed === 'string' ? parsed : '')),
        variables:
          typeof gql.variables === 'string'
            ? gql.variables
            : JSON.stringify(gql.variables || {}, null, 2),
      },
    };
  }

  if (type === 'binary') {
    warn('A binary body was skipped: Relay workspace imports cannot carry file payloads.');
    return base;
  }

  warn(`Unsupported body type "${type}" was imported as a raw body.`);
  return { ...base, mode: 'raw', raw: rawBodyText(parseJson(value, value)) };
}

function convertExampleBody(value) {
  const parsed = parseJson(value, value);
  const base = newBody();
  if (Array.isArray(parsed) || (isRecord(parsed) && Array.isArray(parsed.array))) {
    return { ...base, mode: 'form-urlencoded', form: formRows(parsed) };
  }
  const raw = rawBodyText(parsed);
  let isJson = false;
  try {
    const json = JSON.parse(raw);
    isJson = Boolean(json) && typeof json === 'object';
  } catch {
    isJson = false;
  }
  return { ...base, mode: isJson ? 'json' : 'raw', raw };
}

function convertVariables(value) {
  const obj = parseJson(value, {});
  if (!isRecord(obj)) return [];
  return Object.entries(obj).map(([key, raw]) => ({
    key,
    value: stringValue(raw),
    enabled: true,
    type: 'default',
  }));
}

function mergeGlobals(environments) {
  const byKey = new Map();
  for (const env of environments) {
    for (const variable of convertVariables(env.variables)) {
      byKey.set(variable.key, variable);
    }
  }
  return [...byKey.values()];
}

function sortByOrder(rows) {
  return [...rows].sort((a, b) => num(a.order_index) - num(b.order_index) || num(a.id) - num(b.id));
}

// Wapify scripts run against a `wap` object that is its own pm shim. Relay
// only exposes `pm`, and a few shapes differ (notably response.status is a
// number in Wapify but a status text in Postman). Rewrite the known patterns
// and leave anything unusual for the user to review.
export function convertScript(value) {
  let out = str(value);
  if (!out.trim()) return '';
  out = out
    .replace(/\bwap\.response\.status\b/g, 'pm.response.code')
    .replace(/\bwap\.response\.data\b/g, 'pm.response.json()')
    .replace(/\bwap\.request\.body\b/g, 'pm.request.body.raw')
    .replace(/\bwap\.setEnv\s*\(/g, 'pm.environment.set(')
    .replace(/\bwap\.getEnv\s*\(/g, 'pm.environment.get(')
    .replace(/\bwap\.setEnvironmentVariable\s*\(/g, 'pm.environment.set(')
    .replace(/\bwap\.getEnvironmentVariable\s*\(/g, 'pm.environment.get(')
    .replace(/\bwap\./g, 'pm.');
  // Postman headers are a HeaderList, not a plain object.
  out = out.replace(
    /\bpm\.request\.headers\[\s*(['"])([^'"]+)\1\s*\]\s*=\s*([^;\n]+)/g,
    "pm.request.headers.upsert({ key: '$2', value: $3 })"
  );
  return out;
}

function usesWapScript(value) {
  return /\bwap\s*[.[]/.test(str(value));
}

function hasAnyScript(node) {
  if (!node) return false;
  if (str(node.preRequest).trim() || str(node.tests).trim()) return true;
  return Array.isArray(node.items) && node.items.some(hasAnyScript);
}

function requestNode(row, rows, deleted, warn, stats) {
  const url = splitUrl(row.url);
  const examples = rowsOf(rows.request_examples ?? rows.examples)
    .filter((example) => num(example.request_id) === num(row.id))
    .filter((example) => !deleted.example.has(num(example.id)))
    .sort((a, b) => num(a.id) - num(b.id));

  const bodyVariants = parseJson(row.body_variants, {});
  if (isRecord(bodyVariants) && Object.keys(bodyVariants).length > 0) {
    warn('Some requests had alternate body variants; only the active body was migrated.');
  }
  const extractionRules = parseJson(row.extraction_rules, []);
  if (Array.isArray(extractionRules) && extractionRules.length > 0) {
    warn('Some requests had extraction rules, which Relay does not support; they were skipped.');
  }
  const assertions = parseJson(row.schema_assertions, []);
  if (Array.isArray(assertions) && assertions.length > 0) {
    warn('Some requests had schema assertions, which Relay does not support; they were skipped.');
  }

  const request = newRequest({
    id: `req_wap_${row.id}`,
    name: str(row.name) || 'Untitled Request',
    description: str(row.description),
    method: str(row.method || 'GET').toUpperCase(),
    url: url.url,
    params: url.params,
    headers: convertHeaderRows(row.headers),
    body: convertBody(row.body, row.body_type, warn),
    auth: convertAuth(row.auth_config, warn),
    preRequest: convertScript(row.pre_request_script),
    tests: convertScript(row.post_request_script),
  });
  request.fieldValidations = normalizeFieldValidations(parseJson(row.field_validations, {}));
  request.examples = examples.map((example, index) => {
    const responseHeaders = convertHeaderRows(example.response_headers);
    stats.examples += 1;
    return {
      id: `ex_wap_${example.id}`,
      name: str(example.name) || `Example ${index + 1}`,
      savedAt: str(example.updated_at || example.created_at) || null,
      request: {
        method: str(example.request_method || 'GET').toUpperCase(),
        url: str(example.request_url),
        headers: convertHeaderRows(example.request_headers),
        body: convertExampleBody(example.request_body),
      },
      response: {
        status: num(example.response_status),
        statusText: '',
        headers: responseHeaders,
        body: str(example.response_body),
        contentType: headerValue(responseHeaders, 'content-type'),
      },
    };
  });
  stats.requests += 1;
  return { ...request, type: 'request' };
}

function folderTree(collectionRow, rows, deleted) {
  const collectionId = num(collectionRow.id);
  const folderRows = rowsOf(rows.folders).filter(
    (folder) =>
      num(folder.collection_id) === collectionId && !deleted.folder.has(num(folder.id))
  );
  const folderById = new Map(folderRows.map((folder) => [num(folder.id), folder]));
  const requestRows = rowsOf(rows.requests).filter(
    (request) =>
      num(request.collection_id) === collectionId && !deleted.request.has(num(request.id))
  );

  const parentOf = new Map();
  for (const folder of folderRows) {
    const id = num(folder.id);
    let parent = folder.parent_folder_id == null ? null : num(folder.parent_folder_id);
    if (parent != null && !folderById.has(parent)) parent = null;
    // Break parent cycles so a corrupt row cannot make the build recurse forever.
    const seen = new Set([id]);
    let cursor = parent;
    while (cursor != null) {
      if (seen.has(cursor)) {
        parent = null;
        break;
      }
      seen.add(cursor);
      const ancestor = folderById.get(cursor);
      if (!ancestor) {
        parent = null;
        break;
      }
      cursor = ancestor.parent_folder_id == null ? null : num(ancestor.parent_folder_id);
    }
    parentOf.set(id, parent);
  }

  const foldersByParent = new Map();
  for (const folder of folderRows) {
    const parent = parentOf.get(num(folder.id));
    if (!foldersByParent.has(parent)) foldersByParent.set(parent, []);
    foldersByParent.get(parent).push(folder);
  }

  const requestsByFolder = new Map();
  for (const request of requestRows) {
    let folder = request.folder_id == null ? null : num(request.folder_id);
    if (folder != null && !folderById.has(folder)) folder = null;
    if (!requestsByFolder.has(folder)) requestsByFolder.set(folder, []);
    requestsByFolder.get(folder).push(request);
  }

  return { foldersByParent, requestsByFolder };
}

function buildItems(collectionRow, rows, deleted, warn, stats) {
  const { foldersByParent, requestsByFolder } = folderTree(collectionRow, rows, deleted);
  const buildFolder = (folderRow) => {
    const id = num(folderRow.id);
    stats.folders += 1;
    return {
      ...newFolder(str(folderRow.name) || 'Folder'),
      id: `fld_wap_${id}`,
      items: childItems(id),
    };
  };
  const childItems = (parentId) => {
    const folders = sortByOrder(foldersByParent.get(parentId) || []).map(buildFolder);
    const requests = sortByOrder(requestsByFolder.get(parentId) || []).map((request) =>
      requestNode(request, rows, deleted, warn, stats)
    );
    return [...folders, ...requests];
  };
  return childItems(null);
}

/**
 * Convert Wapbolt rows into Relay workspaces (one per Wapbolt team).
 *
 * `rows` is `{ teams, collections, folders, requests, examples, environments,
 * sync_meta }` with the raw SQLite values. Returns
 * `{ workspaces: [{ workspace, stats }], warnings, stats }`.
 */
export function rowsToWorkspaces(rows = {}) {
  const warnings = new Set();
  const warn = (message) => warnings.add(message);
  const deleted = deletedIds(rows.sync_meta);
  const totals = { collections: 0, folders: 0, requests: 0, examples: 0, environments: 0, globals: 0 };

  const activeCollections = rowsOf(rows.collections).filter(
    (collection) => !deleted.collection.has(num(collection.id))
  );
  const activeEnvironments = rowsOf(rows.environments).filter(
    (environment) => !deleted.environment.has(num(environment.id))
  );
  const globalEnvironments = activeEnvironments.filter((environment) => Boolean(environment.is_global));
  const globals = mergeGlobals(globalEnvironments);
  totals.globals = globals.length;

  let wapScripts = 0;
  for (const collection of activeCollections) {
    if (usesWapScript(collection.pre_request_script) || usesWapScript(collection.post_request_script)) {
      wapScripts += 1;
    }
  }
  for (const request of rowsOf(rows.requests)) {
    if (deleted.request.has(num(request.id))) continue;
    if (usesWapScript(request.pre_request_script) || usesWapScript(request.post_request_script)) {
      wapScripts += 1;
    }
  }
  if (wapScripts) {
    warn(
      `${wapScripts} script(s) used Wapbolt's wap.* API and were rewritten to Relay's pm.* API; review them before trusting scripts.`
    );
  }

  const workspaces = [];
  for (const team of rowsOf(rows.teams)) {
    const collections = activeCollections.filter(
      (collection) => num(collection.team_id) === num(team.id)
    );
    const environments = activeEnvironments.filter(
      (environment) =>
        !environment.is_global && num(environment.team_id) === num(team.id)
    );
    if (!collections.length && !environments.length) continue;

    const stats = { collections: 0, folders: 0, requests: 0, examples: 0, environments: 0 };
    const collectionNodes = collections.map((row) => {
      const collection = newCollection(str(row.name) || 'Collection');
      const collectionStats = { ...stats };
      collection.id = `col_wap_${row.id}`;
      collection.description = str(row.description);
      collection.variables = convertVariables(row.variables);
      collection.auth = convertAuth(row.auth_config, warn);
      // Relay collections cannot inherit; Wapbolt's "Inherit" has no parent here.
      if (collection.auth.type === 'inherit') collection.auth = { ...collection.auth, type: 'none' };
      collection.preRequest = convertScript(row.pre_request_script);
      collection.tests = convertScript(row.post_request_script);
      collection.items = buildItems(row, rows, deleted, warn, collectionStats);
      collection.scriptsTrusted = !hasAnyScript(collection);
      stats.folders = collectionStats.folders;
      stats.requests = collectionStats.requests;
      stats.examples = collectionStats.examples;
      stats.collections += 1;
      if (Boolean(row.chaos_mode)) {
        warn('Collection-level mock chaos was not migrated; configure mock scenarios in Relay.');
      }
      return normalizeCollection(collection);
    });

    const relayEnvironments = environments.map((row) => ({
      id: `env_wap_${row.id}`,
      name: str(row.name) || 'Environment',
      variables: convertVariables(row.variables),
    }));
    stats.environments = relayEnvironments.length;

    const workspace = {
      id: `ws_wap_${team.id}`,
      name: str(team.name) || `Wapbolt Team ${team.id}`,
      collections: collectionNodes,
      environments: relayEnvironments,
      globals,
      history: [],
      activeEnvId: null,
    };
    workspaces.push({ workspace, stats });
    for (const key of Object.keys(totals)) {
      if (key in stats) totals[key] += stats[key];
    }
  }

  return { workspaces, warnings: [...warnings], stats: totals };
}
