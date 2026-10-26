// Collection Runner engine.
//
// Runs an ordered list of requests sequentially. Variables mutated by a
// request's pre-request or test script (via pm.environment / pm.collectionVariables)
// flow into the next request, exactly like Postman's runner.
//
// `send` is injected so the runner uses the same transport as the app
// (Electron bridge in production, fetch fallback in a browser).

import { resolveRequest } from './variables.js';
import { runPreRequest, runTests } from './testRunner.js';
import { withEffectiveAuth, combinedPreRequest, combinedTests, applyRequestPatch } from './inheritance.js';

// Build a display URL that includes enabled query params, so the run report
// shows the full URL actually sent (the transport appends params itself).
function displayUrl(resolved) {
  let base = (resolved.url || '').trim();
  const enabled = (resolved.params || []).filter((p) => p && p.enabled !== false && p.key);
  if (enabled.length === 0) return base;
  const qs = enabled
    .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value ?? '')}`)
    .join('&');
  return base + (base.includes('?') ? '&' : '?') + qs;
}

// Request ids let the transport (and, later, the runner UI) cancel a specific
// send. The browser fallback ignores the second argument.
function newRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export async function runCollection({
  requests,
  send,
  environment = {},
  collection = {},
  globals = {},
  collectionNode = null, // the full collection (for auth/script inheritance)
  delayMs = 0,
  data = null, // array of row objects for data-driven iterations
  iterations = 1, // how many times to run (ignored if data is provided)
  onProgress,
}) {
  // Shared, mutable scopes that persist across every request AND iteration.
  const scopes = {
    environment: { ...environment },
    collection: { ...collection },
    globals: { ...globals },
  };

  // Data-driven: one iteration per data row. Otherwise `iterations` plain runs.
  const rows = Array.isArray(data) && data.length ? data : null;
  const iterCount = rows ? rows.length : Math.max(1, iterations || 1);

  const results = [];
  let passedTests = 0;
  let failedTests = 0;
  let stepCounter = 0;
  const totalSteps = iterCount * requests.length;

  for (let iter = 0; iter < iterCount; iter += 1) {
    const iterationData = rows ? rows[iter] : {};
    scopes.iterationData = iterationData; // exposed as pm.iterationData

    for (let i = 0; i < requests.length; i += 1) {
      const request = requests[i];
      const stepStarted = Date.now();

      // 1. Pre-request script (collection script first, then request's).
      const pre = await runPreRequest(
        combinedPreRequest(request, collectionNode),
        scopes,
        request
      );

      // Apply any pm.request.* mutations the pre-request script made.
      const effectiveRequest = applyRequestPatch(request, pre.requestPatch);

      // 2. Resolve vars. Data-row values are usable as {{col}} and have the
      //    lowest precedence (env > collection > globals > iteration data).
      const vars = {
        ...iterationData,
        ...scopes.globals,
        ...scopes.collection,
        ...scopes.environment,
      };
      const resolved = resolveRequest(withEffectiveAuth(effectiveRequest, collectionNode), vars);

      // 3. Send.
      let response;
      if (pre.error) {
        response = { ok: false, error: `Pre-request error: ${pre.error}`, timeMs: 0 };
      } else {
        response = await send(resolved, newRequestId());
      }

      // 4. Tests (collection tests first, then request's).
      const testRun = await runTests(
        combinedTests(request, collectionNode),
        response,
        scopes,
        resolved
      );
      const stepPassed = testRun.results.filter((r) => r.passed).length;
      const stepFailed = testRun.results.filter((r) => !r.passed).length;
      passedTests += stepPassed;
      failedTests += stepFailed;

      stepCounter += 1;
      const stepResult = {
        index: stepCounter - 1,
        iteration: iter + 1,
        requestId: request.id,
        name: request.name || resolved.url,
        method: resolved.method,
        url: displayUrl(resolved),
        ok: response.ok,
        status: response.ok ? response.status : null,
        error: response.ok ? null : response.error,
        timeMs: response.ok ? response.timeMs : Date.now() - stepStarted,
        tests: testRun.results,
        testsPassed: stepPassed,
        testsFailed: stepFailed,
      };
      results.push(stepResult);

      if (onProgress) onProgress(stepResult, stepCounter, totalSteps);

      if (delayMs > 0 && stepCounter < totalSteps) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  return {
    results,
    scopes,
    summary: {
      iterations: iterCount,
      total: totalSteps,
      requestsOk: results.filter((r) => r.ok).length,
      requestsFailed: results.filter((r) => !r.ok).length,
      testsPassed: passedTests,
      testsFailed: failedTests,
    },
  };
}
