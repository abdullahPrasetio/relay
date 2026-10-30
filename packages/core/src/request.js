// Executes a request stored in a Relay workspace, with no Electron involved.
//
// This is the same pipeline the desktop app runs when the user presses Send:
//   inheritance (auth + ancestor scripts) -> pre-request script -> variable
//   resolution -> transport -> test scripts.
//
// `workspace` is the app's persisted workspace object: its `collections` are
// the nested folder/request tree, `environments` and `globals` are variable
// row lists. See packages/core/src/cli.js for the JSON worker contract.

import { varsToMap, buildScopeVars, resolveRequest } from './variables.js';
import {
  withEffectiveAuth,
  combinedPreRequest,
  combinedTests,
  applyRequestPatch,
} from './inheritance.js';
import { computeAutoHeaders } from './autoHeaders.js';
import { sendRequest } from './request-engine.js';
import { createSendContext } from './network-runtime.js';
import { runScript } from './script-runner.js';
import { normalizeNetworkSettings } from '../../../shared/networkSettings.js';

function searchItems(items, requestId, chain) {
  for (const node of Array.isArray(items) ? items : []) {
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'folder') {
      const found = searchItems(node.items, requestId, [...chain, node]);
      if (found) return found;
    } else if (node.id === requestId) {
      return { request: node, chain };
    }
  }
  return null;
}

/**
 * Locate a stored request by id. Returns `{ request, collection, chain }`,
 * where `chain` is `[collection, ...folders]` (outermost first) — the same
 * shape `findNodePath` produces for the renderer — or null when absent.
 */
export function findStoredRequest(workspace, requestId) {
  if (!workspace || typeof workspace !== 'object' || !requestId) return null;
  const collections = Array.isArray(workspace.collections) ? workspace.collections : [];
  for (const collection of collections) {
    if (!collection || typeof collection !== 'object') continue;
    const found = searchItems(collection.items, requestId, [collection]);
    if (found) {
      return { request: found.request, collection, chain: found.chain };
    }
  }
  return null;
}

/** The environment to resolve against: explicit id, else `activeEnvId`. */
export function findEnvironment(workspace, environmentId) {
  const environments = Array.isArray(workspace?.environments) ? workspace.environments : [];
  const wanted = environmentId || workspace?.activeEnvId || null;
  if (!wanted) return null;
  const environment = environments.find((env) => env && env.id === wanted) || null;
  if (!environment && environmentId) {
    throw new Error(`Environment not found in workspace: ${environmentId}`);
  }
  return environment;
}

function scopesFor(workspace, collection, environment) {
  return {
    local: {},
    iterationData: {},
    environment: varsToMap(environment),
    collection: varsToMap(collection?.variables),
    globals: varsToMap(workspace?.globals),
  };
}

// Resolve inheritance + variables, recording {{tokens}} left unresolved.
function resolveForExecution(sourceRequest, chain, vars) {
  const unresolved = new Set();
  const request = resolveRequest(withEffectiveAuth(sourceRequest, chain), vars, {
    onUnresolved: (name, meta) =>
      unresolved.add(meta?.dynamic ? `{{$${name}}}` : `{{${name}}}`),
  });
  return { request, unresolved: [...unresolved] };
}

/**
 * Build the request that will actually be sent: inherited auth, variables,
 * query params, body — plus the read-only auto headers the Headers tab shows.
 */
export function buildExecutableRequest({ workspace, requestId, environmentId } = {}) {
  const found = findStoredRequest(workspace, requestId);
  if (!found) {
    throw new Error(
      requestId ? `Request not found in workspace: ${requestId}` : 'A requestId is required'
    );
  }
  const environment = findEnvironment(workspace, environmentId);
  const scopes = scopesFor(workspace, found.collection, environment);
  const vars = buildScopeVars(scopes);
  const { request, unresolved } = resolveForExecution(found.request, found.chain, vars);

  return {
    request,
    sourceRequest: found.request,
    collection: found.collection,
    chain: found.chain,
    environment,
    scopes,
    vars,
    autoHeaders: computeAutoHeaders(request),
    unresolved,
    // Imported collections are untrusted until the user allows their scripts;
    // an automated worker cannot prompt, so it treats false as "skip scripts".
    trusted: found.collection?.scriptsTrusted !== false,
  };
}

/** Flat `{name: value}` map used to resolve a stored request. */
export function resolveVariables({ workspace, requestId, environmentId } = {}) {
  return buildExecutableRequest({ workspace, requestId, environmentId }).vars;
}

/**
 * Send one already-resolved request through the same engine the app uses.
 * `network` is app-level network settings (proxy/TLS/timeout); missing values
 * fall back to the defaults. The promise rejects only on setup errors.
 */
export async function executeRequest(request, { network, cookieJar = null } = {}) {
  const ctx = createSendContext({
    network: normalizeNetworkSettings(network || {}),
    request,
  });
  try {
    return await sendRequest(request, { ...ctx.options, cookieJar: cookieJar || null });
  } finally {
    ctx.cleanup();
  }
}

function errorMessage(err) {
  return err && err.message ? err.message : String(err);
}

/**
 * Run a stored request end to end.
 *
 * Returns `{ response, testResults, error }`:
 *   response    { status, headers, body, timeMs } or null when nothing was sent
 *   testResults [{ name, passed, error? }] — empty array when no tests ran
 *   error       null, or the transport/pre-request failure message
 *
 * HTTP error statuses are responses, not errors; assertion failures land in
 * testResults. `error` is set only when execution itself failed.
 */
export async function runStoredRequest({
  workspace,
  requestId,
  environmentId = null,
  network,
  cookieJar = null,
} = {}) {
  let built;
  try {
    built = buildExecutableRequest({ workspace, requestId, environmentId });
  } catch (err) {
    return { response: null, testResults: [], error: errorMessage(err) };
  }

  const networkSettings = normalizeNetworkSettings(network || {});
  const send = (request) => executeRequest(request, { network: networkSettings, cookieJar });
  const scriptOptions = { send, jar: cookieJar, trusted: built.trusted };

  // 1. Pre-request script: collection and folders outermost-in, then the
  //    request's own. Scripts may mutate the request through pm.request.
  const preScript = combinedPreRequest(built.sourceRequest, built.chain);
  let pre = { requestPatch: {}, error: null };
  if (preScript) {
    pre = await runScript({
      phase: 'pre',
      script: preScript,
      request: built.sourceRequest,
      context: built.scopes,
      ...scriptOptions,
    });
  }
  if (pre.error) {
    return {
      response: null,
      testResults: [],
      error: `Pre-request script error: ${pre.error}`,
    };
  }
  // runScript works on copies and returns them; adopt the mutated scopes so
  // pm.environment/collectionVariables writes affect the URL we send.
  const context = pre.context || built.scopes;

  // 2. Apply pm.request.* mutations, then resolve inherited auth + variables
  //    with any scopes the pre-request script changed.
  const patched = applyRequestPatch(built.sourceRequest, pre.requestPatch);
  const { request: resolved } = resolveForExecution(
    patched,
    built.chain,
    buildScopeVars(context)
  );

  // 3. Send.
  let result;
  try {
    result = await executeRequest(resolved, { network: networkSettings, cookieJar });
  } catch (err) {
    result = { ok: false, error: errorMessage(err), timeMs: 0 };
  }
  if (!result.ok) {
    return {
      response: { status: null, headers: [], body: '', timeMs: result.timeMs || 0 },
      testResults: [],
      error: result.error || 'Request failed',
    };
  }

  // 4. Tests run against the sent response.
  const testScript = combinedTests(built.sourceRequest, built.chain);
  let testResults = [];
  if (testScript) {
    const testRun = await runScript({
      phase: 'test',
      script: testScript,
      response: result,
      request: resolved,
      context,
      ...scriptOptions,
    });
    testResults = (testRun.results || []).map((entry) => ({
      name: entry.name,
      passed: entry.passed === true,
      ...(entry.error ? { error: entry.error } : {}),
    }));
  }

  return {
    response: {
      status: result.status ?? null,
      headers: Array.isArray(result.headers) ? result.headers : [],
      body: typeof result.body === 'string' ? result.body : '',
      timeMs: result.timeMs || 0,
    },
    testResults,
    error: null,
  };
}
