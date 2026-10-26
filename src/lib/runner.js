// Collection Runner engine.
//
// Runs an ordered list of requests sequentially. Variables mutated by a
// request's pre-request or test script (via pm.environment / pm.collectionVariables)
// flow into the next request, exactly like Postman's runner.
//
// `send` is injected so the runner uses the same transport as the app
// (Electron bridge in production, fetch fallback in a browser).

import { buildScopeVars, resolveRequest } from './variables.js';
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
  collectionNode = null, // the full collection (backwards-compatible shorthand)
  collectionChain = null, // [collection, ...folders], outermost first
  delayMs = 0,
  data = null, // array of row objects for data-driven iterations
  iterations = 1, // how many times to run (ignored if data is provided)
  onProgress,
}) {
  // Ancestor chain for auth/script inheritance. The old `collectionNode`
  // parameter is still accepted as a single-element chain.
  const chain = Array.isArray(collectionChain)
    ? collectionChain.filter(Boolean)
    : collectionNode
      ? [collectionNode]
      : [];
  const trusted = chain[0]?.scriptsTrusted !== false;

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
  let stopRun = false; // pm.execution.setNextRequest(null) stops the whole run

  for (let iter = 0; iter < iterCount && !stopRun; iter += 1) {
    const iterationData = rows ? rows[iter] : {};

    // pm.execution.setNextRequest jumps around the list; the guards below keep
    // that finite:
    // - `null` stops the whole run (Postman's "stop"), including later
    //   data-driven iterations.
    // - an unknown id/name ends the current iteration instead of looping.
    // - each jump target may be jumped INTO once per iteration. Sequentially
    //   reaching it later is free, but jumping to it a second time stops the
    //   iteration, so A -> B -> A -> B cannot spin forever.
    const jumpCounts = new Map();
    let index = 0;
    let stopIteration = false;

    while (!stopIteration && index >= 0 && index < requests.length) {
      const request = requests[index];
      const stepStarted = Date.now();

      // local is per execution: scripts may read/write it, but it is never
      // persisted and does not leak into the next request.
      const context = {
        local: {},
        iterationData,
        environment: scopes.environment,
        collection: scopes.collection,
        globals: scopes.globals,
      };

      // 1. Pre-request script: collection, folders outermost -> innermost,
      //    then the request's own script.
      const pre = await runPreRequest(
        combinedPreRequest(request, chain),
        context,
        request,
        { trusted }
      );

      // Apply any pm.request.* mutations the pre-request script made.
      const effectiveRequest = applyRequestPatch(request, pre.requestPatch);
      const skipRequested = pre.skip === true;

      // 2. Resolve vars with Postman precedence:
      //    local > iteration data > environment > collection > globals.
      const vars = buildScopeVars(context);
      const resolved = resolveRequest(withEffectiveAuth(effectiveRequest, chain), vars);

      // 3. Send, unless the pre-request script asked to skip the request.
      let response;
      if (skipRequested) {
        response = { ok: true, status: null, statusText: '', headers: [], body: '', timeMs: 0 };
      } else if (pre.error) {
        response = { ok: false, error: `Pre-request error: ${pre.error}`, timeMs: 0 };
      } else {
        response = await send(resolved, newRequestId());
      }

      // 4. Tests (ancestor tests first, then request's). A skipped request never
      //    runs its tests either.
      const testRun = skipRequested
        ? { ran: false, results: [] }
        : await runTests(combinedTests(request, chain), response, context, resolved, {
            trusted,
          });

      // `pm.execution.skipRequest()` in a test script still marks the step as
      // skipped; Postman uses it to stop the remaining scripts of the step.
      const skipped = skipRequested || testRun.skip === true;
      const stepPassed = skipped ? 0 : testRun.results.filter((r) => r.passed).length;
      const stepFailed = skipped ? 0 : testRun.results.filter((r) => !r.passed).length;
      passedTests += stepPassed;
      failedTests += stepFailed;

      // A test-script jump wins over a pre-request jump: it saw the response.
      const scriptNext = testRun.nextRequestSet
        ? testRun.nextRequest
        : pre.nextRequestSet
          ? pre.nextRequest
          : undefined;

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
        skipped,
        timeMs: response.ok ? response.timeMs : Date.now() - stepStarted,
        tests: testRun.results,
        testsPassed: stepPassed,
        testsFailed: stepFailed,
        nextRequest: scriptNext === undefined ? null : scriptNext,
      };
      results.push(stepResult);

      if (onProgress) onProgress(stepResult, stepCounter, totalSteps);

      // 5. Resolve the jump for the next step.
      let nextIndex = index + 1;
      if (scriptNext === null) {
        stopRun = true;
        stopIteration = true;
      } else if (scriptNext !== undefined) {
        const target = requests.findIndex(
          (candidate) => candidate.id === scriptNext || candidate.name === scriptNext
        );
        if (target < 0) {
          stopIteration = true;
        } else if ((jumpCounts.get(target) || 0) >= 1) {
          stopIteration = true;
        } else {
          jumpCounts.set(target, (jumpCounts.get(target) || 0) + 1);
          nextIndex = target;
        }
      }

      if (delayMs > 0 && stepCounter < totalSteps) {
        await new Promise((r) => setTimeout(r, delayMs));
      }

      index = nextIndex;
    }
  }

  return {
    results,
    scopes,
    summary: {
      iterations: iterCount,
      total: totalSteps,
      requestsOk: results.filter((r) => r.ok && !r.skipped).length,
      requestsFailed: results.filter((r) => !r.ok && !r.skipped).length,
      requestsSkipped: results.filter((r) => r.skipped).length,
      testsPassed: passedTests,
      testsFailed: failedTests,
    },
  };
}
