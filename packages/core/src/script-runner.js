// Executes user pre-request and test scripts in the MAIN (Node) process.
//
// ESM version, bundled directly into main.js by Vite. This avoids the fragile
// "copy a .cjs into dist-electron" step that could leave a stale script runner
// (and a missing `moment`) behind. Modules are imported statically so Vite
// resolves them at build time.
//
// Runs here on purpose: the renderer's strict CSP (script-src) forbids eval.
// The user body itself executes inside `runInSandbox` (a fresh vm realm with
// code generation disabled); this module only builds the pm.* surface host-side
// and injects it. The pm.* surface lives in packages/core/src/pm/**; see
// packages/core/src/sandbox/index.js for the threat model and the remaining host-object
// bridge that `utilityProcess` will close.

import * as CryptoJSNS from 'crypto-js';
import * as uuidNS from 'uuid';
import * as momentNS from 'moment';
import { buildPm } from './pm/index.js';
import { createSandboxRequire, runInSandbox } from './sandbox/index.js';

const DEFAULT_TIMEOUT_MS = 5000;

// crypto-js / moment are CommonJS. Depending on the bundler's CJS<->ESM
// interop, the usable object may be the namespace itself or its `.default`.
// `unwrap` picks whichever actually carries the expected members so scripts
// get a working object (fixes "Cannot read properties of undefined (MD5)").
function unwrap(ns, probeKey) {
  if (ns && typeof ns[probeKey] !== 'undefined') return ns;
  if (ns && ns.default && typeof ns.default[probeKey] !== 'undefined') return ns.default;
  return ns && ns.default ? ns.default : ns;
}

const CryptoJS = unwrap(CryptoJSNS, 'MD5');
const uuid = unwrap(uuidNS, 'v4');
const moment = typeof momentNS === 'function' ? momentNS : unwrap(momentNS, 'now');

// Scripts get the three bundled modules and nothing else. Allowing any host
// module (node:crypto included) would hand scripts a bridge back to the host.
const sandboxRequire = createSandboxRequire({
  'crypto-js': CryptoJS,
  moment,
  uuid,
});

// Resolve `pending` within what is left of the script budget. vm's timeout only
// covers synchronous work, so async pm.sendRequest calls need their own guard.
function awaitWithinBudget(promise, deadline, budgetMs) {
  const remaining = deadline - Date.now();
  const timeoutError = new Error(`Script timed out after ${budgetMs}ms`);
  if (remaining <= 0) return Promise.reject(timeoutError);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError), remaining);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// phase: 'pre' | 'test'
// context: { local, environment, collection, globals, iterationData } plain objects
// send: the engine's sendRequest, enabling pm.sendRequest
// jar: optional persisted cookie jar for pm.cookies
// trusted: false skips execution entirely (collection not trusted yet)
// Returns {
//   ran, results, logs, error, requestPatch, context,
//   nextRequest, nextRequestSet, skip, visualizer,
// }.
// `nextRequest`/`nextRequestSet` carry pm.execution.setNextRequest (null means
// "stop the run"); `skip` carries pm.execution.skipRequest; `visualizer` is the
// pm.visualizer.set payload, left for the renderer to render later.
export async function runScript({
  phase,
  script,
  response,
  context,
  request,
  send,
  jar,
  trusted,
  timeoutMs,
} = {}) {
  // Shared contract with the renderer: untrusted collections never run code.
  if (trusted === false) {
    return {
      ran: false,
      warning: 'Scripts from this collection are not trusted yet',
      results: [],
      logs: [],
    };
  }

  const ctx = {
    local: { ...(context?.local || {}) },
    environment: { ...(context?.environment || {}) },
    collection: { ...(context?.collection || {}) },
    globals: { ...(context?.globals || {}) },
    iterationData: { ...(context?.iterationData || {}) },
  };

  const emptyOutcome = {
    nextRequest: null,
    nextRequestSet: false,
    skip: false,
    visualizer: null,
  };

  const source = typeof script === 'string' ? script : String(script ?? '');
  if (!source.trim()) {
    return {
      ran: false,
      results: [],
      logs: [],
      error: null,
      requestPatch: {},
      context: ctx,
      ...emptyOutcome,
    };
  }

  const budgetMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.round(timeoutMs) : DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + budgetMs;
  const results = [];
  // Records any pm.request.* mutations the script makes, returned to the caller.
  const requestPatch = {};
  const pending = []; // in-flight pm.sendRequest / async pm.test promises
  const asyncErrors = []; // throws from sendRequest callbacks (inside promises)
  const { pm, postman, executionState, visualizerRef } = buildPm({
    response: phase === 'test' ? response : null,
    results,
    context: ctx,
    request,
    requestPatch,
    send,
    jar,
    pending,
    asyncErrors,
  });

  // Postman also exposes the bundled libraries as implicit globals, so scripts
  // can use CryptoJS/uuid/moment without require(); btoa/atob are built from the
  // host Buffer (Buffer itself is never in the sandbox).
  const sandboxResult = runInSandbox({
    code: source,
    timeoutMs: budgetMs,
    globals: {
      pm,
      postman,
      expect: pm.expect,
      require: sandboxRequire,
      CryptoJS,
      moment,
      uuid,
      btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
      atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    },
  });
  const { logs } = sandboxResult;
  let error = sandboxResult.error || null;

  // Wait for pm.sendRequest(...) calls so their callbacks and variable writes
  // land before the context is returned. Timers the script scheduled get their
  // chance to run during this window. Work that settles after the budget is
  // spent is not observed (the renderer already got its timeout error).
  if (pending.length) {
    try {
      await awaitWithinBudget(Promise.all(pending), deadline, budgetMs);
    } catch (err) {
      if (!error) error = err && err.message ? err.message : String(err);
    }
  }
  sandboxResult.cleanup();

  for (const err of asyncErrors) {
    if (!error) error = err && err.message ? err.message : String(err);
  }

  const outcome = {
    nextRequest: executionState.nextRequestSet ? executionState.nextRequest : null,
    nextRequestSet: executionState.nextRequestSet,
    skip: executionState.skip === true,
    visualizer: visualizerRef.value,
  };

  if (error) {
    if (phase === 'test') {
      results.push({ name: 'Script error', passed: false, error });
    }
    return { ran: true, results, logs, error, requestPatch, context: ctx, ...outcome };
  }

  return { ran: true, results, logs, error: null, requestPatch, context: ctx, ...outcome };
}
