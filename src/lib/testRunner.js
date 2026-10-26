// Renderer-side thin wrappers that run user scripts in the MAIN process.
//
// The renderer runs under a strict CSP (script-src 'self') that forbids
// eval/new Function, so the actual script execution happens in Node via the
// `script:run` IPC channel (see electron/script-runner.cjs). These wrappers
// pass a mutable `context` { local, iterationData, environment, collection,
// globals } and copy any mutations back into it so callers see variable
// changes. `local` is per execution and never persisted.

const hasBridge = typeof window !== 'undefined' && !!window.api && !!window.api.runScript;

const SCOPE_KEYS = ['local', 'iterationData', 'environment', 'collection', 'globals'];

function applyContextBack(context, returned) {
  if (!context || !returned) return;
  for (const key of SCOPE_KEYS) {
    const next = returned[key];
    if (!next) continue;
    const current = context[key] || (context[key] = {});
    Object.keys(current).forEach((k) => {
      if (!(k in next)) delete current[k];
    });
    Object.assign(current, next);
  }
}

// Run a test script after a response. `request` gives scripts pm.request.
export async function runTests(script, response, context, request, options = {}) {
  if (!script || !script.trim()) return { ran: false, results: [] };
  if (!hasBridge) {
    return {
      ran: true,
      results: [{ name: 'Script error', passed: false, error: 'Script engine unavailable (no bridge).' }],
    };
  }
  const out = await window.api.runScript({
    phase: 'test',
    script,
    response,
    context,
    request,
    trusted: options.trusted !== false,
  });
  applyContextBack(context, out.context);
  return {
    ran: out.ran,
    results: out.results || [],
    logs: out.logs || [],
    // Conditional flow (pm.execution.setNextRequest / skipRequest).
    nextRequest: out.nextRequest ?? null,
    nextRequestSet: out.nextRequestSet === true,
    skip: out.skip === true,
  };
}

// Run a pre-request script before sending. `request` gives scripts pm.request.
export async function runPreRequest(script, context, request, options = {}) {
  if (!script || !script.trim()) return { ran: false };
  if (!hasBridge) {
    return { ran: true, error: 'Script engine unavailable (no bridge).' };
  }
  const out = await window.api.runScript({
    phase: 'pre',
    script,
    context,
    request,
    trusted: options.trusted !== false,
  });
  applyContextBack(context, out.context);
  return {
    ran: out.ran,
    error: out.error,
    requestPatch: out.requestPatch || {},
    logs: out.logs || [],
    // Conditional flow (pm.execution.setNextRequest / skipRequest).
    nextRequest: out.nextRequest ?? null,
    nextRequestSet: out.nextRequestSet === true,
    skip: out.skip === true,
  };
}
