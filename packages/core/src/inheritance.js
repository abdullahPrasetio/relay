// Resolves ancestor inheritance for a request: auth and scripts.
//
// Postman model:
// - An ancestor chain is [collection, ...folders] (outermost -> innermost),
//   as produced by collectionTree.findNodePath.
// - A request with auth.type === 'inherit' uses the nearest ancestor that
//   defines a concrete auth type, falling back to the collection.
// - Pre-request/test scripts run outside-in: collection, folders outermost ->
//   innermost, then the request's own script. All share the same pm scopes.

function toChain(chainOrNode) {
  if (Array.isArray(chainOrNode)) return chainOrNode.filter(Boolean);
  return chainOrNode ? [chainOrNode] : [];
}

export function effectiveAuth(request, chainOrNode) {
  const own = request?.auth;
  if (own && own.type !== 'inherit') return own;

  // Walk deepest -> outermost so the closest ancestor wins.
  const chain = toChain(chainOrNode);
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const auth = chain[i]?.auth;
    if (auth && auth.type !== 'inherit') return auth;
  }
  return { type: 'none' };
}

// Returns a request clone with its auth resolved to a concrete type, so the
// request engine (which knows nothing about inheritance) applies it correctly.
export function withEffectiveAuth(request, chainOrNode) {
  return { ...request, auth: effectiveAuth(request, chainOrNode) };
}

// Combine ancestor scripts (outermost first) with the request's own script.
export function combinedPreRequest(request, chainOrNode) {
  return joinScripts(
    ...toChain(chainOrNode).map((node) => node?.preRequest),
    request?.preRequest
  );
}

export function combinedTests(request, chainOrNode) {
  return joinScripts(
    ...toChain(chainOrNode).map((node) => node?.tests),
    request?.tests
  );
}

function joinScripts(...scripts) {
  return scripts
    .filter((s) => typeof s === 'string' && s.trim())
    .join('\n;\n');
}

// Merge a pm.request key/value delta onto a stored list.
// - `upserts` (patch.params / patch.pathVars) updates entries by key or appends
//   new ones; entries already in the request keep their position.
// - `removed` (patch.removedParams / patch.removedPathVars) deletes by key.
// Keys compare case-insensitively so `Query.add({key:'X'})` cannot duplicate an
// existing `x`, matching Postman's HeaderList/QueryParamList behavior.
function mergeKvList(existing, upserts, removed, withEnabled) {
  const removedKeys = new Set(
    (Array.isArray(removed) ? removed : []).map((key) => String(key).toLowerCase())
  );
  const out = [];
  for (const item of Array.isArray(existing) ? existing : []) {
    if (!item || item.key == null) continue;
    if (removedKeys.has(String(item.key).toLowerCase())) continue;
    out.push({ ...item });
  }
  for (const update of Array.isArray(upserts) ? upserts : []) {
    if (!update || update.key == null) continue;
    const key = String(update.key);
    if (removedKeys.has(key.toLowerCase())) continue;
    const idx = out.findIndex(
      (item) => String(item.key ?? '').toLowerCase() === key.toLowerCase()
    );
    if (idx >= 0) {
      out[idx] = { ...out[idx], ...update };
    } else {
      out.push(withEnabled ? { ...update, enabled: update.enabled !== false } : { ...update });
    }
  }
  return out;
}

// Apply pm.request.* mutations made by a pre-request script onto the request
// that will actually be sent.
//
// `headers`/`body` are already merged as before. Query params and path vars are
// deltas (see pm/request.js): upserts merge by key, and the `removed*` lists
// delete entries. The incoming request is never mutated.
export function applyRequestPatch(request, patch) {
  if (!patch || Object.keys(patch).length === 0) return request;
  const next = { ...request };
  if (patch.method != null) next.method = patch.method;
  if (patch.url != null) next.url = patch.url;
  if (patch.headers != null) {
    next.headers = patch.headers.map((h) => ({
      key: h.key,
      value: h.value,
      enabled: h.enabled !== false,
    }));
  }
  if (patch.body != null) {
    next.body = { ...request.body, ...patch.body };
  }
  if (patch.params != null || patch.removedParams != null) {
    next.params = mergeKvList(request.params, patch.params, patch.removedParams, true);
  }
  if (patch.pathVars != null || patch.removedPathVars != null) {
    next.pathVars = mergeKvList(request.pathVars, patch.pathVars, patch.removedPathVars, false);
  }
  return next;
}
