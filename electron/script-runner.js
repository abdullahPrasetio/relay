// Executes user pre-request and test scripts in the MAIN (Node) process.
//
// ESM version, bundled directly into main.js by Vite. This avoids the fragile
// "copy a .cjs into dist-electron" step that could leave a stale script runner
// (and a missing `moment`) behind. Modules are imported statically so Vite
// resolves them at build time.
//
// Runs here on purpose: the renderer's strict CSP (script-src) forbids eval.
// This is NOT a hardened sandbox against hostile scripts; it is a convenience
// runner for the user's own scripts, matching Postman's pm.* subset.

import * as CryptoJSNS from 'crypto-js';
import * as uuidNS from 'uuid';
import * as momentNS from 'moment';
import * as nodeCrypto from 'node:crypto';

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

class AssertionError extends Error {}

function fmt(v) {
  if (typeof v === 'string') return `"${v}"`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

class Expectation {
  constructor(actual) {
    this.actual = actual;
    this.negate = false;
    this.to = this;
    this.be = this;
    this.been = this;
    this.is = this;
    this.that = this;
    this.have = this;
    this.has = this;
    this.and = this;
  }
  get not() {
    this.negate = !this.negate;
    return this;
  }
  _check(pass, message) {
    const ok = this.negate ? !pass : pass;
    if (!ok) throw new AssertionError(message);
  }
  equal(expected) {
    this._check(this.actual === expected, `expected ${fmt(this.actual)} to equal ${fmt(expected)}`);
    return this;
  }
  eql(expected) {
    this._check(
      JSON.stringify(this.actual) === JSON.stringify(expected),
      `expected ${fmt(this.actual)} to deeply equal ${fmt(expected)}`
    );
    return this;
  }
  a(type) {
    this._check(typeof this.actual === type, `expected ${fmt(this.actual)} to be a ${type}`);
    return this;
  }
  an(type) {
    return this.a(type);
  }
  include(sub) {
    const ok =
      (typeof this.actual === 'string' && this.actual.includes(sub)) ||
      (Array.isArray(this.actual) && this.actual.includes(sub));
    this._check(ok, `expected ${fmt(this.actual)} to include ${fmt(sub)}`);
    return this;
  }
  above(n) {
    this._check(this.actual > n, `expected ${fmt(this.actual)} to be above ${n}`);
    return this;
  }
  below(n) {
    this._check(this.actual < n, `expected ${fmt(this.actual)} to be below ${n}`);
    return this;
  }
  get ok() {
    this._check(!!this.actual, `expected ${fmt(this.actual)} to be truthy`);
    return this;
  }
  get true() {
    this._check(this.actual === true, `expected ${fmt(this.actual)} to be true`);
    return this;
  }
  get false() {
    this._check(this.actual === false, `expected ${fmt(this.actual)} to be false`);
    return this;
  }
  property(name) {
    const ok = this.actual != null && Object.prototype.hasOwnProperty.call(this.actual, name);
    this._check(ok, `expected object to have property "${name}"`);
    return this;
  }
}

// Build a Postman-like pm.request that scripts can READ and MUTATE. Mutations
// are recorded into `patch`, which the caller applies to the outgoing request.
function buildRequestApi(request, patch) {
  const r = request || {};
  const headers = (r.headers || [])
    .filter((h) => h && h.enabled !== false && h.key)
    .map((h) => ({ key: h.key, value: h.value, enabled: true }));
  const body = r.body || { mode: 'none', raw: '' };

  // Working copies the script sees and edits.
  const workingHeaders = headers.slice();
  const bodyState = {
    mode: body.mode || 'none',
    raw: body.raw ?? '',
    form: (body.form || []).slice(),
  };

  const bodyApi = {
    get mode() {
      return bodyState.mode;
    },
    set mode(v) {
      bodyState.mode = v;
      patch.body = { ...bodyState };
    },
    get raw() {
      return bodyState.raw;
    },
    set raw(v) {
      bodyState.raw = v;
      patch.body = { ...bodyState };
    },
    get form() {
      return bodyState.form;
    },
    // Postman-style: pm.request.body.update(newRaw) or update({mode,raw})
    update(next) {
      if (typeof next === 'string') bodyState.raw = next;
      else if (next && typeof next === 'object') {
        if (next.mode != null) bodyState.mode = next.mode;
        if (next.raw != null) bodyState.raw = next.raw;
        if (next.form != null) bodyState.form = next.form;
      }
      patch.body = { ...bodyState };
    },
  };

  const headersApi = {
    all: () => workingHeaders.map((h) => ({ key: h.key, value: h.value })),
    get: (name) => {
      const hit = workingHeaders.find((h) => h.key.toLowerCase() === String(name).toLowerCase());
      return hit ? hit.value : undefined;
    },
    add: (h) => {
      if (h && h.key) {
        workingHeaders.push({ key: h.key, value: h.value ?? '', enabled: true });
        patch.headers = workingHeaders.slice();
      }
    },
    upsert: (h) => {
      if (!h || !h.key) return;
      const existing = workingHeaders.find((x) => x.key.toLowerCase() === h.key.toLowerCase());
      if (existing) existing.value = h.value ?? '';
      else workingHeaders.push({ key: h.key, value: h.value ?? '', enabled: true });
      patch.headers = workingHeaders.slice();
    },
    remove: (name) => {
      const idx = workingHeaders.findIndex((x) => x.key.toLowerCase() === String(name).toLowerCase());
      if (idx >= 0) {
        workingHeaders.splice(idx, 1);
        patch.headers = workingHeaders.slice();
      }
    },
  };

  const api = {
    get method() {
      return patch.method != null ? patch.method : r.method || 'GET';
    },
    set method(v) {
      patch.method = v;
    },
    get url() {
      return patch.url != null ? patch.url : r.url || '';
    },
    set url(v) {
      patch.url = v;
    },
    headers: headersApi,
    // addHeader alias at request level (Postman has pm.request.headers.add)
    addHeader: (h) => headersApi.add(h),
    body: bodyApi,
  };
  return api;
}

function buildPm(response, results, context, request, requestPatch, send, pending) {
  const envObj = context.environment || {};
  const colObj = context.collection || {};
  const globalsObj = context.globals || {};
  const iterationData = context.iterationData || {};

  const environment = makeVarStore(envObj);
  const collectionVariables = makeVarStore(colObj);
  const globals = makeVarStore(globalsObj);

  const variables = {
    get: (key) => {
      if (key in envObj) return envObj[key];
      if (key in colObj) return colObj[key];
      if (key in globalsObj) return globalsObj[key];
      if (key in iterationData) return iterationData[key];
      return undefined;
    },
    has: (key) =>
      key in envObj || key in colObj || key in globalsObj || key in iterationData,
    set: (key, value) => {
      envObj[key] = value;
    },
  };

  // pm.iterationData: read-only access to the current data-file row.
  const iterationDataApi = {
    get: (key) => iterationData[key],
    has: (key) => key in iterationData,
    toObject: () => ({ ...iterationData }),
  };

  const text = response && response.ok ? response.body : '';
  const code = response && response.ok ? response.status : 0;

  const responseApi = {
    code,
    status: response?.statusText || '',
    responseTime: response?.timeMs ?? 0,
    text: () => text,
    json: () => JSON.parse(text),
    to: {
      have: {
        status: (expected) => {
          if (code !== expected) {
            throw new AssertionError(`expected status ${expected} but got ${code}`);
          }
        },
        header: (name) => {
          const found = (response?.headers || []).some(
            (h) => h.key.toLowerCase() === String(name).toLowerCase()
          );
          if (!found) throw new AssertionError(`expected header "${name}"`);
        },
      },
      be: {
        get ok() {
          if (!(code >= 200 && code < 300)) {
            throw new AssertionError(`expected 2xx but got ${code}`);
          }
          return true;
        },
      },
    },
  };

  // pm.sendRequest(urlOrReq, callback?) -> fires an ad-hoc HTTP request via the
  // engine. Supports Postman's callback style and also returns a Promise.
  // Any in-flight call is tracked in `pending` so runScript awaits it.
  const sendRequestApi = (reqArg, callback) => {
    const normalized = normalizeScriptRequest(reqArg);
    const p = (send ? send(normalized) : Promise.resolve({ ok: false, error: 'sendRequest unavailable' }))
      .then((res) => {
        const wrapped = wrapScriptResponse(res);
        if (typeof callback === 'function') callback(null, wrapped);
        return wrapped;
      })
      .catch((err) => {
        if (typeof callback === 'function') callback(err, null);
        throw err;
      });
    if (pending) pending.push(p.catch(() => {}));
    return p;
  };

  return {
    response: responseApi,
    request: buildRequestApi(request, requestPatch),
    sendRequest: sendRequestApi,
    environment,
    collectionVariables,
    globals,
    variables,
    iterationData: iterationDataApi,
    expect: (actual) => new Expectation(actual),
    test: (name, fn) => {
      try {
        fn();
        results.push({ name, passed: true });
      } catch (err) {
        results.push({ name, passed: false, error: err && err.message ? err.message : String(err) });
      }
    },
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
  if (Array.isArray(r.header)) headers = r.header.map((h) => ({ key: h.key, value: h.value, enabled: h.disabled !== true }));
  else if (Array.isArray(r.headers)) headers = r.headers.map((h) => ({ key: h.key, value: h.value, enabled: h.enabled !== false }));
  else if (r.header && typeof r.header === 'object') headers = Object.entries(r.header).map(([key, value]) => ({ key, value, enabled: true }));

  // Body: support { mode:'raw', raw } and { mode:'urlencoded'/'formdata' } and a plain string.
  let body = { mode: 'none' };
  const rb = r.body;
  if (typeof rb === 'string') body = { mode: 'raw', raw: rb };
  else if (rb && rb.mode === 'raw') body = { mode: 'raw', raw: rb.raw ?? '' };
  else if (rb && rb.raw != null) body = { mode: 'raw', raw: rb.raw };

  const url = typeof r.url === 'string' ? r.url : r.url?.raw || '';
  return { method: (r.method || 'GET').toUpperCase(), url, headers, params: [], body };
}

// Wrap the engine's response into a pm-style response object scripts can read.
function wrapScriptResponse(res) {
  const text = res && res.ok ? res.body : '';
  return {
    code: res?.ok ? res.status : 0,
    status: res?.statusText || '',
    responseTime: res?.timeMs ?? 0,
    ok: !!res?.ok,
    headers: res?.headers || [],
    text: () => text,
    json: () => JSON.parse(text),
  };
}

// Collects console output so the UI can show it (console.log in a script is
// otherwise invisible). Also echoes to the main-process stdout.
function makeConsole(sink) {
  const fmtArg = (a) => {
    if (typeof a === 'string') return a;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  };
  const record = (level, args) => {
    const text = args.map(fmtArg).join(' ');
    sink.push({ level, text });
    console[level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'log']('[script]', text);
  };
  return {
    log: (...a) => record('log', a),
    info: (...a) => record('log', a),
    error: (...a) => record('error', a),
    warn: (...a) => record('warn', a),
  };
}

// Whitelisted require() for scripts, matching common Postman modules.
const ALLOWED_MODULES = {
  'crypto-js': () => CryptoJS,
  uuid: () => uuid,
  moment: () => moment,
  crypto: () => nodeCrypto,
  'node:crypto': () => nodeCrypto,
};

function sandboxRequire(name) {
  const loader = ALLOWED_MODULES[name];
  if (!loader) {
    throw new Error(
      `require('${name}') is not available. Supported modules: ${Object.keys(ALLOWED_MODULES).join(', ')}`
    );
  }
  return loader();
}

// phase: 'pre' | 'test'
// context: { environment, collection, globals } plain objects
// send: the engine's sendRequest, enabling pm.sendRequest
// Returns { ran, results, error, context } where context carries back mutations.
export async function runScript({ phase, script, response, context, request, send }) {
  const ctx = {
    environment: { ...(context?.environment || {}) },
    collection: { ...(context?.collection || {}) },
    globals: { ...(context?.globals || {}) },
    iterationData: { ...(context?.iterationData || {}) },
  };

  if (!script || !script.trim()) {
    return { ran: false, results: [], context: ctx };
  }

  const results = [];
  // Records any pm.request.* mutations the script makes, returned to the caller.
  const requestPatch = {};
  const logs = []; // console.log output captured for the UI
  const pending = []; // in-flight pm.sendRequest promises to await
  const pm = buildPm(phase === 'test' ? response : null, results, ctx, request, requestPatch, send, pending);

  try {
    // Postman does NOT run user scripts in strict mode, so implicit globals
    // (`timestamp = ...`) are allowed. A Proxy-backed `with` scope captures
    // those writes into a per-run store, while real globals still resolve.
    const store = Object.create(null);
    // Postman exposes several libraries as implicit globals (no require needed):
    // CryptoJS, _ (lodash-ish — not bundled, omitted), moment, uuid, plus
    // btoa/atob. We expose the ones we ship so familiar scripts "just work".
    const passthrough = {
      pm,
      expect: pm.expect,
      console: makeConsole(logs),
      require: sandboxRequire,
      CryptoJS,
      moment,
      uuid,
      btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
      atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    };
    const scope = new Proxy(store, {
      has: () => true,
      get: (target, key) => {
        if (key === Symbol.unscopables) return undefined;
        if (key in passthrough) return passthrough[key];
        if (key in target) return target[key];
        if (key in globalThis) return globalThis[key];
        return undefined;
      },
      set: (target, key, value) => {
        target[key] = value;
        return true;
      },
    });
    // eslint-disable-next-line no-new-func
    const fn = new Function('__scope__', 'with (__scope__) {\n' + script + '\n}');
    fn(scope);
    // Wait for any pm.sendRequest(...) calls to settle so their callbacks/
    // variable writes complete before we return the context.
    if (pending.length) await Promise.all(pending);
    return { ran: true, results, context: ctx, requestPatch, logs };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (phase === 'pre') {
      return { ran: true, results, error: message, context: ctx, requestPatch, logs };
    }
    results.push({ name: 'Script error', passed: false, error: message });
    return { ran: true, results, context: ctx, requestPatch, logs };
  }
}
