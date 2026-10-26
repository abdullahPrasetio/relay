// Postman-style {{variable}} substitution.
// Replaces {{name}} tokens using the active environment's variables.

export function resolveVars(str, vars) {
  if (typeof str !== 'string' || !str) return str;
  return str.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, name) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      return vars[name];
    }
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

// Resolution hierarchy, lowest priority first: globals, then collection vars,
// then environment vars (environment wins), matching Postman's precedence.
export function mergeVars(collection, environment, globals) {
  return {
    ...varsToMap(globals),
    ...varsToMap(collection?.variables),
    ...varsToMap(environment),
  };
}

function resolveKvList(list, vars) {
  return (list || []).map((item) => ({
    ...item,
    key: resolveVars(item.key, vars),
    value: resolveVars(item.value, vars),
  }));
}

// Resolve {{vars}} inside any nested auth config. Auth shapes vary by type
// (oauth1/awsv4/jwt/… were added after the original bearer/basic set), so walk
// the structure instead of listing fields — a new provider needs no change here.
function resolveDeep(value, vars) {
  if (typeof value === 'string') return resolveVars(value, vars);
  if (Array.isArray(value)) return value.map((v) => resolveDeep(v, vars));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveDeep(v, vars);
    return out;
  }
  return value;
}

function resolveAuth(auth, vars) {
  if (!auth) return auth;
  const out = {};
  for (const [key, value] of Object.entries(auth)) out[key] = resolveDeep(value, vars);
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
export function resolveRequest(request, vars) {
  const pathMap = pathVarsToMap(request.pathVars);
  const urlWithPath = resolvePathVars(request.url, pathMap);
  return {
    ...request,
    url: resolveVars(urlWithPath, vars),
    params: resolveKvList(request.params, vars),
    headers: resolveKvList(request.headers, vars),
    auth: resolveAuth(request.auth, vars),
    body: request.body
      ? {
          ...request.body,
          raw: resolveVars(request.body.raw, vars),
          form: resolveKvList(request.body.form, vars),
          graphql: request.body.graphql
            ? {
                query: resolveVars(request.body.graphql.query, vars),
                variables: resolveVars(request.body.graphql.variables, vars),
              }
            : request.body.graphql,
        }
      : request.body,
  };
}
