// Postman-style {{variable}} substitution.
// Replaces {{name}} tokens using the active environment's variables.
//
// `{{$dynamic}}` tokens are expanded first, before any scope lookup, so a
// scope entry literally named "$guid" never shadows the generator. Unknown
// dynamic tokens stay verbatim; `onUnresolved(name, { dynamic })` reports
// both dynamic and normal misses when supplied.

const DYNAMIC_RE = /\{\{\s*(\$[\w.-]+)\s*\}\}/g;
const TOKEN_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

// Small deterministic-looking pools: enough variety to look real in a request
// without pulling in a faker dependency.
const FIRST_NAMES = ['Ada', 'Grace', 'Alan', 'Linus', 'Margaret', 'Ken', 'Barbara', 'Dennis'];
const LAST_NAMES = ['Lovelace', 'Hopper', 'Turing', 'Torvalds', 'Hamilton', 'Thompson', 'Liskov', 'Ritchie'];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function randomUuid() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const DYNAMIC = {
  $guid: () => randomUuid(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(Math.floor(Math.random() * 1001)),
  $randomFirstName: () => pick(FIRST_NAMES),
  $randomEmail: () => {
    const first = pick(FIRST_NAMES).toLowerCase();
    const last = pick(LAST_NAMES).toLowerCase();
    return `${first}.${last}@example.com`;
  },
};

export function expandDynamicVars(str, onUnresolved) {
  if (typeof str !== 'string' || !str) return str;
  return str.replace(DYNAMIC_RE, (match, name) => {
    const generate = DYNAMIC[name];
    if (generate) return generate();
    if (typeof onUnresolved === 'function') onUnresolved(name, { dynamic: true });
    return match; // leave unresolved dynamic tokens as-is
  });
}

export function resolveVars(str, vars, { onUnresolved } = {}) {
  if (typeof str !== 'string' || !str) return str;
  const map = vars || {};
  const expanded = expandDynamicVars(str, onUnresolved);
  return expanded.replace(TOKEN_RE, (match, name) => {
    if (Object.prototype.hasOwnProperty.call(map, name)) {
      return map[name];
    }
    if (typeof onUnresolved === 'function') onUnresolved(name, { dynamic: false });
    return match; // leave unresolved tokens as-is
  });
}

// Build a flat {name: value} map from a variable list (environment or collection).
export function varsToMap(source) {
  const map = {};
  const list = Array.isArray(source) ? source : source?.variables;
  if (!Array.isArray(list)) return map;
  for (const v of list) {
    if (v && v.enabled !== false && v.key) {
      map[v.key] = v.value ?? '';
    }
  }
  return map;
}

// Backwards-compatible alias.
export function envToMap(environment) {
  return varsToMap(environment);
}

// Plaintext values of secret variables, for masking logs and exports. Values
// shorter than 2 chars are skipped: masking "a" would mangle unrelated text.
export function secretValues(rows) {
  const list = Array.isArray(rows) ? rows : rows?.variables;
  if (!Array.isArray(list)) return [];
  return list
    .filter((v) => v && v.type === 'secret' && typeof v.value === 'string' && v.value.length >= 2)
    .map((v) => v.value);
}

// Replace every occurrence of a known secret with a mask. Used on console
// output (and any other string that may be persisted or exported).
export function maskSecrets(text, secrets = []) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const value of secrets) {
    if (typeof value === 'string' && value.length >= 2) out = out.split(value).join('••••');
  }
  return out;
}

// Resolution hierarchy, lowest priority first: globals, collection,
// environment, iteration data, then the per-execution local scope. This is
// Postman's precedence (local > data > environment > collection > globals).
// All five inputs are plain {name: value} maps.
export function buildScopeVars({
  local,
  iterationData,
  environment,
  collection,
  globals,
} = {}) {
  return {
    ...(globals || {}),
    ...(collection || {}),
    ...(environment || {}),
    ...(iterationData || {}),
    ...(local || {}),
  };
}

// Resolution hierarchy for the three persisted scopes (environment wins).
// Kept for callers that don't have local/iteration-data scopes.
export function mergeVars(collection, environment, globals) {
  return buildScopeVars({
    collection: varsToMap(collection?.variables),
    environment: varsToMap(environment),
    globals: varsToMap(globals),
  });
}

function resolveKvList(list, vars, options) {
  return (list || []).map((item) => ({
    ...item,
    key: resolveVars(item.key, vars, options),
    value: resolveVars(item.value, vars, options),
  }));
}

// Resolve {{vars}} inside any nested auth config. Auth shapes vary by type
// (oauth1/awsv4/jwt/… were added after the original bearer/basic set), so walk
// the structure instead of listing fields — a new provider needs no change here.
function resolveDeep(value, vars, options) {
  if (typeof value === 'string') return resolveVars(value, vars, options);
  if (Array.isArray(value)) return value.map((v) => resolveDeep(v, vars, options));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveDeep(v, vars, options);
    return out;
  }
  return value;
}

function resolveAuth(auth, vars, options) {
  if (!auth) return auth;
  const out = {};
  for (const [key, value] of Object.entries(auth)) out[key] = resolveDeep(value, vars, options);
  // Legacy data may omit this default; apiKey needs it to know where to go.
  if (out.apikey && !out.apikey.addTo) out.apikey.addTo = 'header';
  return out;
}

// Extract :path variable names from a URL (e.g. /users/:id/posts/:postId).
// Ignores the scheme's "://" so https:// isn't mistaken for a path var.
export function extractPathVars(url) {
  if (typeof url !== 'string' || !url) return [];
  const afterScheme = url.replace(/^[a-z]+:\/\//i, '');
  const names = [];
  const re = /\/:([A-Za-z_]\w*)/g;
  let m;
  while ((m = re.exec(afterScheme)) !== null) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

// Substitute :name path segments using a {name: value} map.
function resolvePathVars(url, pathMap) {
  if (typeof url !== 'string' || !url || !pathMap) return url;
  return url.replace(/(^|\/):([A-Za-z_]\w*)/g, (match, pre, name) => {
    if (Object.prototype.hasOwnProperty.call(pathMap, name) && pathMap[name] !== '') {
      return pre + encodeURIComponent(pathMap[name]);
    }
    return match;
  });
}

// Build a {name: value} map from a request's pathVars list.
export function pathVarsToMap(pathVars) {
  const map = {};
  for (const p of pathVars || []) {
    if (p && p.key) map[p.key] = p.value ?? '';
  }
  return map;
}

// Apply variable resolution across an entire request object. Path vars (:id)
// are substituted first, then {{var}} tokens everywhere.
// `options` is forwarded to resolveVars, so callers can observe unresolved
// tokens (e.g. `{ onUnresolved }`) without a second pass over the request.
export function resolveRequest(request, vars, options) {
  const pathMap = pathVarsToMap(request.pathVars);
  const urlWithPath = resolvePathVars(request.url, pathMap);
  return {
    ...request,
    url: resolveVars(urlWithPath, vars, options),
    params: resolveKvList(request.params, vars, options),
    headers: resolveKvList(request.headers, vars, options),
    auth: resolveAuth(request.auth, vars, options),
    body: request.body
      ? {
          ...request.body,
          raw: resolveVars(request.body.raw, vars, options),
          form: resolveKvList(request.body.form, vars, options),
          graphql: request.body.graphql
            ? {
                query: resolveVars(request.body.graphql.query, vars, options),
                variables: resolveVars(request.body.graphql.variables, vars, options),
              }
            : request.body.graphql,
        }
      : request.body,
  };
}
