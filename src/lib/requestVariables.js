// Collect unique {{variable}} names used by a request.
const VAR_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

function collect(value, out) {
  if (typeof value === 'string') {
    VAR_RE.lastIndex = 0;
    let match;
    while ((match = VAR_RE.exec(value)) !== null) out.add(match[1]);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collect(entry, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) collect(entry, out);
  }
}

export function collectRequestVariables(request) {
  const out = new Set();
  if (!request || typeof request !== 'object') return [];
  collect(request.url, out);
  collect(request.params, out);
  collect(request.pathVars, out);
  collect(request.headers, out);
  collect(request.body, out);
  collect(request.auth, out);
  collect(request.preRequest, out);
  collect(request.tests, out);
  return [...out];
}
