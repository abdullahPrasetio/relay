// Renderer-side thin wrappers that run user scripts in the MAIN process.
//
// The renderer runs under a strict CSP (script-src 'self') that forbids
// eval/new Function, so the actual script execution happens in Node via the
// `script:run` IPC channel (see electron/script-runner.cjs). These wrappers
// pass a mutable `context` { environment, collection, globals } and copy any
// mutations back into it so callers see variable changes.

const hasBridge = typeof window !== 'undefined' && !!window.api && !!window.api.runScript;

function applyContextBack(context, returned) {
  if (!context || !returned) return;
  if (returned.environment) {
    Object.keys(context.environment || {}).forEach((k) => {
      if (!(k in returned.environment)) delete context.environment[k];
    });
    Object.assign(context.environment || (context.environment = {}), returned.environment);
  }
  if (returned.collection) {
    Object.keys(context.collection || {}).forEach((k) => {
      if (!(k in returned.collection)) delete context.collection[k];
    });
    Object.assign(context.collection || (context.collection = {}), returned.collection);
  }
  if (returned.globals) {
    Object.keys(context.globals || {}).forEach((k) => {
      if (!(k in returned.globals)) delete context.globals[k];
    });
    Object.assign(context.globals || (context.globals = {}), returned.globals);
  }
}

// Run a test script after a response. `request` gives scripts pm.request.
export async function runTests(script, response, context, request) {
  if (!script || !script.trim()) return { ran: false, results: [] };
  if (!hasBridge) {
    return {
      ran: true,
      results: [{ name: 'Script error', passed: false, error: 'Script engine unavailable (no bridge).' }],
    };
  }
  const out = await window.api.runScript({ phase: 'test', script, response, context, request });
  applyContextBack(context, out.context);
  return { ran: out.ran, results: out.results || [], logs: out.logs || [] };
}

// Run a pre-request script before sending. `request` gives scripts pm.request.
export async function runPreRequest(script, context, request) {
  if (!script || !script.trim()) return { ran: false };
  if (!hasBridge) {
    return { ran: true, error: 'Script engine unavailable (no bridge).' };
  }
  const out = await window.api.runScript({ phase: 'pre', script, context, request });
  applyContextBack(context, out.context);
  return { ran: out.ran, error: out.error, requestPatch: out.requestPatch || {}, logs: out.logs || [] };
}
