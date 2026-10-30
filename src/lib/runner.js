// Collection Runner engine.
//
// Runs an ordered list of requests sequentially. Variables mutated by a
// request's pre-request or test script (via pm.environment / pm.collectionVariables)
// flow into the next request, exactly like Postman's runner.
//
// `send` is injected so the runner uses the same transport as the app
// (Electron bridge in production, fetch fallback in a browser).

import { buildScopeVars, resolveRequest } from '../../packages/core/src/variables.js';
import { runPreRequest, runTests } from './testRunner.js';
import { withEffectiveAuth, combinedPreRequest, combinedTests, applyRequestPatch } from '../../packages/core/src/inheritance.js';

// Response snapshots kept by `saveResponses` are capped so a huge body cannot
// bloat the in-memory report.
export const RESPONSE_SNAPSHOT_LIMIT = 128 * 1024;

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

// Request ids let the transport (and the runner UI) cancel a specific send.
// The browser fallback ignores the second argument.
function newRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function headerValue(headers, name) {
  const wanted = name.toLowerCase();
  if (Array.isArray(headers)) {
    const found = headers.find((h) => String(h?.key || h?.name || '').toLowerCase() === wanted);
    return found ? String(found.value ?? '') : '';
  }
  if (headers && typeof headers === 'object') {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === wanted);
    return key ? String(headers[key] ?? '') : '';
  }
  return '';
}

function isTextualContentType(contentType) {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!ct) return true; // the engine falls back to UTF-8 validity
  return /^text\//.test(ct)
    || /^application\/(json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|problem\+json|ld\+json)$/.test(ct)
    || /\+json$/.test(ct)
    || /\+xml$/.test(ct);
}

// Keep only a small, report-safe view of the response. Binary payloads are
// never copied, and textual bodies are truncated to the snapshot limit.
function snapshotResponse(response) {
  const contentType = headerValue(response.headers, 'content-type');
  const textual = response.isBinary === false
    || (response.isBinary === undefined && isTextualContentType(contentType));
  let body = null;
  if (textual && typeof response.body === 'string') {
    body = response.body.length > RESPONSE_SNAPSHOT_LIMIT
      ? response.body.slice(0, RESPONSE_SNAPSHOT_LIMIT)
      : response.body;
  }
  return { status: response.status ?? null, contentType, body };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  retries = 0, // extra attempts for failed/5xx requests
  retryDelayMs = 0,
  stopOnError = false, // stop the whole run after the first failed step
  saveResponses = false, // keep a truncated response snapshot per step
  keepVariableValues = true, // persist variable mutations after the run
  shouldStop = null, // callback checked before every request
  onRequestId = null, // callback fired with the id right before each send
  runScript = null, // injected script executor (CLI); absent = renderer bridge
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

  // Snapshot used to restore the scopes when keepVariableValues is false.
  const initialScopes = {
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
  let stoppedReason = null;
  let aborted = false;
  let stoppedAtStep = null;

  const maxAttempts = 1 + Math.max(0, Math.floor(Number(retries) || 0));
  const retryDelay = Math.max(0, Number(retryDelayMs) || 0);

  // `shouldStop` is authoritative: it wins over any scripted jump, including
  // the jump-cycle guard below.
  function isStopRequested() {
    if (typeof shouldStop !== 'function') return false;
    try {
      return shouldStop() === true;
    } catch {
      return false;
    }
  }

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
      // UI cancellation is checked before every request.
      if (isStopRequested()) {
        aborted = true;
        stoppedAtStep = stepCounter;
        stopRun = true;
        stopIteration = true;
        break;
      }

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
        { trusted, runScript }
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
      let attempts = 0;
      if (skipRequested) {
        response = { ok: true, status: null, statusText: '', headers: [], body: '', timeMs: 0 };
      } else if (pre.error) {
        response = { ok: false, error: `Pre-request error: ${pre.error}`, timeMs: 0 };
      } else {
        // Retry transport failures and 5xx responses up to `retries` times.
        while (attempts < maxAttempts) {
          attempts += 1;
          const requestId = newRequestId();
          if (typeof onRequestId === 'function') onRequestId(requestId);
          try {
            response = await send(resolved, requestId);
          } catch (err) {
            response = {
              ok: false,
              status: null,
              error: err?.message || String(err),
              timeMs: Date.now() - stepStarted,
            };
          }
          const retryable = !response.ok || (typeof response.status === 'number' && response.status >= 500);
          if (!retryable || attempts >= maxAttempts) break;
          if (retryDelay > 0) await sleep(retryDelay);
        }
      }

      // 4. Tests (ancestor tests first, then request's). A skipped request never
      //    runs its tests either.
      const testRun = skipRequested
        ? { ran: false, results: [] }
        : await runTests(combinedTests(request, chain), response, context, resolved, {
            trusted,
            runScript,
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
        attempts,
        retried: attempts > 1,
        timeMs: response.ok ? response.timeMs : Date.now() - stepStarted,
        tests: testRun.results,
        testsPassed: stepPassed,
        testsFailed: stepFailed,
        nextRequest: scriptNext === undefined ? null : scriptNext,
      };
      if (saveResponses) stepResult.response = snapshotResponse(response);
      results.push(stepResult);

      if (onProgress) onProgress(stepResult, stepCounter, totalSteps);

      // A failure is a transport error, a 5xx response, or a failed assertion.
      const stepIsFailure = !skipped
        && (!response.ok
          || (typeof response.status === 'number' && response.status >= 500)
          || stepFailed > 0);

      // The UI may have requested a stop while this request was in flight; the
      // active send was aborted, and no further request may start.
      if (isStopRequested()) {
        aborted = true;
        stoppedAtStep = stepCounter;
        stopRun = true;
        stopIteration = true;
      } else if (stopOnError && stepIsFailure) {
        stoppedReason = 'error';
        stopRun = true;
        stopIteration = true;
      } else {
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
        index = nextIndex;
      }

      if (!stopRun && !stopIteration && delayMs > 0 && stepCounter < totalSteps && !isStopRequested()) {
        await sleep(delayMs);
      }
    }
  }

  // keepVariableValues === false restores the pre-run values so a later run
  // (or the persisted environment) starts from the same baseline.
  const finalScopes = keepVariableValues
    ? scopes
    : {
        environment: { ...initialScopes.environment },
        collection: { ...initialScopes.collection },
        globals: { ...initialScopes.globals },
      };

  return {
    results,
    scopes: finalScopes,
    summary: {
      iterations: iterCount,
      total: totalSteps,
      requestsOk: results.filter((r) => r.ok && !r.skipped).length,
      requestsFailed: results.filter((r) => !r.ok && !r.skipped).length,
      requestsSkipped: results.filter((r) => r.skipped).length,
      testsPassed: passedTests,
      testsFailed: failedTests,
      retriedRequests: results.filter((r) => r.retried).length,
      aborted,
      stoppedAtStep: aborted ? stoppedAtStep : null,
      stoppedReason,
    },
  };
}
