// Assembles the `pm` object handed to user scripts (ROADMAP Fase 3.2 parity).
//
// Everything is built in the MAIN process and injected into the sandbox realm
// as an ordinary object: the sandbox itself has no host globals, no
// `require`, no `process`, and no top-level await. Each builder below closes
// over plain-data scopes, so a script can only reach what it is given.
//
// Scope precedence for reads (highest first):
//   local > environment > collection > globals > iteration data
// `pm.variables` writes to `local` (Postman's temporary scope); the explicit
// `pm.environment` / `pm.collectionVariables` / `pm.globals` stores write to
// their own object, which the caller persists after the run.

import { expect } from './assertions.js';
import { buildRequestApi } from './request.js';
import { buildResponseApi, wrapScriptResponse } from './response.js';

function makeVarStore(obj) {
  return {
    get: (key) => (key in obj ? obj[key] : undefined),
    set: (key, value) => {
      obj[key] = value;
    },
    unset: (key) => {
      delete obj[key];
    },
    has: (key) => key in obj,
    clear: () => {
      for (const k of Object.keys(obj)) delete obj[k];
    },
    toObject: () => ({ ...obj }),
  };
}

// Normalize pm.sendRequest's argument (a URL string or a Postman-ish request
// object) into the shape our engine expects.
function normalizeScriptRequest(reqArg) {
  if (typeof reqArg === 'string') {
    return { method: 'GET', url: reqArg, headers: [], params: [], body: { mode: 'none' } };
  }
  const r = reqArg || {};
  // Headers may be an object map or an array of {key,value}.
  let headers = [];
  if (Array.isArray(r.header)) {
    headers = r.header.map((h) => ({ key: h.key, value: h.value, enabled: h.disabled !== true }));
  } else if (Array.isArray(r.headers)) {
    headers = r.headers.map((h) => ({ key: h.key, value: h.value, enabled: h.enabled !== false }));
  } else if (r.header && typeof r.header === 'object') {
    headers = Object.entries(r.header).map(([key, value]) => ({ key, value, enabled: true }));
  }

  // Body: support { mode:'raw', raw }, a plain string, and urlencoded/formdata.
  let body = { mode: 'none' };
  const rb = r.body;
  if (typeof rb === 'string') body = { mode: 'raw', raw: rb };
  else if (rb && rb.mode === 'raw') body = { mode: 'raw', raw: rb.raw ?? '' };
  else if (rb && rb.raw != null) body = { mode: 'raw', raw: rb.raw };

  const url = typeof r.url === 'string' ? r.url : r.url?.raw || '';
  return { method: (r.method || 'GET').toUpperCase(), url, headers, params: [], body };
}

// `response.cookies[]` (set by the engine) and the optional persisted jar.
export function buildCookiesApi(response, jar) {
  const map = {};
  const put = (cookie) => {
    if (!cookie || cookie.name == null) return;
    map[String(cookie.name)] = cookie.value == null ? '' : String(cookie.value);
  };
  for (const cookie of Array.isArray(jar) ? jar : []) put(cookie);
  // Response cookies win over the stored jar: they are the freshest values.
  for (const cookie of Array.isArray(response?.cookies) ? response.cookies : []) put(cookie);
  return {
    get: (name) => (String(name) in map ? map[String(name)] : undefined),
    has: (name) => String(name) in map,
    toObject: () => ({ ...map }),
    all: () => Object.entries(map).map(([name, value]) => ({ name, value })),
  };
}

// Build pm + the legacy `postman` alias. Returns the mutable pieces the caller
// needs after the script finishes (next-request command, visualizer payload).
export function buildPm({
  response,
  results = [],
  context,
  request,
  requestPatch,
  send,
  jar,
  pending,
  asyncErrors,
}) {
  const localObj = (context && context.local) || {};
  const envObj = (context && context.environment) || {};
  const colObj = (context && context.collection) || {};
  const globalsObj = (context && context.globals) || {};
  const iterationData = (context && context.iterationData) || {};

  const environment = makeVarStore(envObj);
  const collectionVariables = makeVarStore(colObj);
  const globals = makeVarStore(globalsObj);

  const readOrder = [localObj, envObj, colObj, globalsObj, iterationData];
  const readVar = (key) => {
    for (const scope of readOrder) {
      if (key in scope) return scope[key];
    }
    return undefined;
  };

  const variables = {
    get: readVar,
    has: (key) => readOrder.some((scope) => key in scope),
    set: (key, value) => {
      localObj[key] = value;
    },
    unset: (key) => {
      delete localObj[key];
    },
    clear: () => {
      for (const k of Object.keys(localObj)) delete localObj[k];
    },
    toObject: () => {
      const merged = {};
      for (const scope of readOrder) Object.assign(merged, scope);
      return merged;
    },
    // Values are inserted via a replacer function so `$&`/`$1` in a variable
    // value are not interpreted as replacement patterns.
    replaceIn: (template) =>
      String(template ?? '').replace(/{{\s*([^{}]+?)\s*}}/g, (match, name) => {
        const value = readVar(name);
        return value === undefined || value === null ? match : String(value);
      }),
  };

  const iterationDataApi = {
    get: (key) => (key in iterationData ? iterationData[key] : undefined),
    set: (key, value) => {
      iterationData[key] = value;
    },
    unset: (key) => {
      delete iterationData[key];
    },
    has: (key) => key in iterationData,
    toObject: () => ({ ...iterationData }),
  };

  const executionState = { nextRequest: null, nextRequestSet: false, skip: false };
  const execution = {
    setNextRequest: (target) => {
      // `null`/`undefined` both mean "stop the run"; keep the flag so the
      // caller can distinguish "never called" from "explicitly null".
      executionState.nextRequest = target == null ? null : String(target);
      executionState.nextRequestSet = true;
    },
    skipRequest: () => {
      executionState.skip = true;
    },
  };

  const visualizerRef = { value: null };
  const visualizer = {
    set(template, data) {
      visualizerRef.value = {
        template: template == null ? '' : String(template),
        // The payload crosses the IPC boundary (structured clone), which
        // rejects functions and circular data. Normalize it to plain JSON so a
        // script cannot break the run by handing the visualizer something
        // uncloneable; rendering is deferred to the UI anyway.
        data: toPlainData(data),
      };
      return visualizerRef.value;
    },
    get: () => visualizerRef.value,
    clear: () => {
      visualizerRef.value = null;
    },
  };

  const sendRequestApi = (reqArg, callback) => {
    const normalized = normalizeScriptRequest(reqArg);
    let invoked = false;
    // A callback runs outside runInContext; a throw there would otherwise turn
    // into a silent unhandled rejection, so it is recorded for the caller.
    const callCallback = (err, wrapped) => {
      if (typeof callback !== 'function' || invoked) return;
      invoked = true;
      try {
        callback(err, wrapped);
      } catch (e) {
        if (Array.isArray(asyncErrors)) asyncErrors.push(e);
        throw e;
      }
    };
    const promise = (
      send ? send(normalized) : Promise.resolve({ ok: false, error: 'sendRequest unavailable' })
    )
      .then((res) => {
        const wrapped = wrapScriptResponse(res);
        callCallback(null, wrapped);
        return wrapped;
      })
      .catch((err) => {
        callCallback(err, null);
        throw err;
      });
    if (Array.isArray(pending)) pending.push(promise.catch(() => {}));
    return promise;
  };

  // pm.test also accepts an async function: the wrapper is tracked in `pending`
  // so its result lands before runScript snapshots `results`.
  const test = (name, fn) => {
    const label = String(name);
    if (typeof fn !== 'function') {
      results.push({ name: label, passed: false, error: 'pm.test expects a function' });
      return;
    }
    let returned;
    try {
      returned = fn();
    } catch (err) {
      results.push({ name: label, passed: false, error: errorMessage(err) });
      return;
    }
    if (returned && typeof returned.then === 'function') {
      const tracked = Promise.resolve(returned).then(
        () => {
          results.push({ name: label, passed: true });
        },
        (err) => {
          results.push({ name: label, passed: false, error: errorMessage(err) });
        }
      );
      if (Array.isArray(pending)) pending.push(tracked);
      return;
    }
    results.push({ name: label, passed: true });
  };

  const pm = {
    response: buildResponseApi(response),
    request: buildRequestApi(request, requestPatch),
    cookies: buildCookiesApi(response, jar),
    variables,
    environment,
    collectionVariables,
    globals,
    iterationData: iterationDataApi,
    execution,
    visualizer,
    expect,
    test,
    sendRequest: sendRequestApi,
  };

  // Legacy (pre-pm) API still used by older collections. Environment/global
  // accessors intentionally read only their own scope.
  const postman = {
    setEnvironmentVariable: (key, value) => {
      envObj[key] = value;
    },
    getEnvironmentVariable: (key) => (key in envObj ? envObj[key] : undefined),
    clearEnvironmentVariable: (key) => {
      delete envObj[key];
    },
    setGlobalVariable: (key, value) => {
      globalsObj[key] = value;
    },
    getGlobalVariable: (key) => (key in globalsObj ? globalsObj[key] : undefined),
    clearGlobalVariable: (key) => {
      delete globalsObj[key];
    },
    setNextRequest: (target) => execution.setNextRequest(target),
  };

  return { pm, postman, executionState, visualizerRef };
}

// Errors thrown by the sandbox realm are not host `Error` instances, so the
// message property (not `instanceof`) is the portable check here.
function errorMessage(err) {
  if (err && typeof err.message === 'string' && err.message) return err.message;
  return err == null ? 'unknown error' : String(err);
}

function toPlainData(value) {
  if (value == null) return null;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? null : JSON.parse(json);
  } catch {
    return null;
  }
}
