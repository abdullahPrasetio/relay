// Resolves collection-level inheritance for a request: auth and scripts.
//
// Postman model (simplified to collection level):
// - A request with auth.type === 'inherit' uses its collection's auth.
// - Collection pre-request/test scripts run around the request's own scripts.

export function effectiveAuth(request, collection) {
  const auth = request.auth || { type: 'inherit' };
  if (auth.type === 'inherit') {
    // Fall back to the collection's auth; if the collection also has none,
    // the request effectively has no auth.
    return collection?.auth && collection.auth.type !== 'inherit'
      ? collection.auth
      : { type: 'none' };
  }
  return auth;
}

// Returns a request clone with its auth resolved to a concrete type, so the
// request engine (which knows nothing about inheritance) applies it correctly.
export function withEffectiveAuth(request, collection) {
  return { ...request, auth: effectiveAuth(request, collection) };
}

// Combine collection + request scripts. Collection runs first (outer),
// then the request's own script. Both share the same pm scopes.
export function combinedPreRequest(request, collection) {
  return joinScripts(collection?.preRequest, request.preRequest);
}

export function combinedTests(request, collection) {
  return joinScripts(collection?.tests, request.tests);
}

function joinScripts(a, b) {
  const parts = [];
  if (a && a.trim()) parts.push(a);
  if (b && b.trim()) parts.push(b);
  return parts.join('\n;\n');
}

// Apply pm.request.* mutations made by a pre-request script onto the request
// that will actually be sent (method / url / headers / body).
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
  return next;
}
