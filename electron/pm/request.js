// pm.request surface (ROADMAP Fase 3.2).
//
// Scripts mutate a request before it is sent. The caller (script-runner) owns
// the request object, so mutations are NOT applied here: they are recorded into
// `patch` and merged by `applyRequestPatch` in src/lib/inheritance.js. That keeps
// the script realm free of app state and makes the mutation testable as data.
//
// Patch shape (kept intentionally small and mergeable):
//   { method?, url?, headers?, body?,
//     params?: [{key,value,enabled}], removedParams?: [key],
//     pathVars?: [{key,value}], removedPathVars?: [key] }
// `headers` is the full list (same as before); `params`/`pathVars` are merged by
// key onto the outgoing request, with the `removed*` lists deleting entries that
// `remove()` dropped. Unknown keys never delete anything.

import { findHeader, headersToObject, normalizeHeaderList, toHeaderEntry } from './headers.js';

function toParamEntry(input) {
  if (!input || typeof input !== 'object') return null;
  const key = input.key ?? input.name;
  if (key == null || String(key).trim() === '') return null;
  return {
    key: String(key),
    value: input.value == null ? '' : String(input.value),
    enabled: input.enabled !== false && input.disabled !== true,
  };
}

function toPathVarEntry(input) {
  if (!input || typeof input !== 'object') return null;
  const key = input.key ?? input.name;
  if (key == null || String(key).trim() === '') return null;
  return { key: String(key), value: input.value == null ? '' : String(input.value) };
}

function toFormEntry(input) {
  if (!input || typeof input !== 'object') return null;
  const key = input.key ?? input.name;
  if (key == null || String(key).trim() === '') return null;
  const entry = { key: String(key), value: input.value == null ? '' : String(input.value), enabled: input.enabled !== false };
  if (input.type) entry.type = String(input.type);
  return entry;
}

function assembleUrlFromObject(obj) {
  const protocol = obj.protocol ? `${String(obj.protocol).replace(/:$/, '')}://` : '';
  const host = Array.isArray(obj.host) ? obj.host.join('.') : obj.host ? String(obj.host) : '';
  const port = obj.port ? `:${obj.port}` : '';
  let path = '';
  if (Array.isArray(obj.path)) path = `/${obj.path.map(String).join('/')}`;
  else if (obj.pathname != null) path = String(obj.pathname);
  else if (obj.path != null) path = String(obj.path);
  if (path && !path.startsWith('/')) path = `/${path}`;
  // `query` is deliberately excluded: it is recorded as request.params, which
  // the transport appends. Including it here too would duplicate it on the wire.
  return `${protocol}${host}${port}${path}`;
}

export function buildRequestApi(request, patch) {
  const r = request || {};

  const state = {
    method: typeof r.method === 'string' ? r.method : 'GET',
    url: typeof r.url === 'string' ? r.url : '',
  };
  if (patch.method != null) state.method = patch.method;
  if (patch.url != null) state.url = patch.url;

  const workingHeaders = normalizeHeaderList(r.headers).map((h) => ({ ...h }));
  const workingParams = (Array.isArray(r.params) ? r.params : [])
    .filter((p) => p && p.key != null)
    .map((p) => ({ key: String(p.key), value: p.value == null ? '' : String(p.value), enabled: p.enabled !== false }));
  const workingPathVars = (Array.isArray(r.pathVars) ? r.pathVars : [])
    .filter((p) => p && p.key != null)
    .map((p) => ({ key: String(p.key), value: p.value == null ? '' : String(p.value) }));
  const removedParams = new Set();
  const removedPathVars = new Set();

  const bodySource = r.body && typeof r.body === 'object' ? r.body : {};
  const bodyState = {
    mode: typeof bodySource.mode === 'string' ? bodySource.mode : 'none',
    raw: bodySource.raw == null ? '' : String(bodySource.raw),
    form: Array.isArray(bodySource.form) ? bodySource.form.map((f) => ({ ...f })) : [],
  };

  const syncHeaders = () => {
    patch.headers = workingHeaders.map((h) => ({ ...h }));
  };
  const syncParams = () => {
    patch.params = workingParams.map((p) => ({ ...p }));
    if (removedParams.size) patch.removedParams = [...removedParams];
  };
  const syncPathVars = () => {
    patch.pathVars = workingPathVars.map((p) => ({ ...p }));
    if (removedPathVars.size) patch.removedPathVars = [...removedPathVars];
  };
  const syncBody = () => {
    patch.body = {
      mode: bodyState.mode,
      raw: bodyState.raw,
      form: bodyState.form.map((f) => ({ ...f })),
    };
  };

  // --- headers ------------------------------------------------------------
  const findWorkingHeader = (name) => findHeader(workingHeaders, name);
  const headersApi = {
    all: () => workingHeaders.map((h) => ({ key: h.key, value: h.value })),
    get: (name) => {
      const hit = findWorkingHeader(name);
      return hit ? hit.value : undefined;
    },
    has: (name) => Boolean(findWorkingHeader(name)),
    one: (name) => {
      const hit = name == null ? workingHeaders[0] : findWorkingHeader(name);
      return hit ? { key: hit.key, value: hit.value } : undefined;
    },
    toObject: () => headersToObject(workingHeaders),
    add: (input) => {
      const entry = toHeaderEntry(input);
      if (!entry) return;
      workingHeaders.push(entry);
      syncHeaders();
    },
    upsert: (input) => {
      const entry = toHeaderEntry(input);
      if (!entry) return;
      const existing = findWorkingHeader(entry.key);
      if (existing) {
        existing.value = entry.value;
        existing.enabled = entry.enabled;
      } else {
        workingHeaders.push(entry);
      }
      syncHeaders();
    },
    remove: (name) => {
      const idx = workingHeaders.findIndex(
        (h) => h.key.toLowerCase() === String(name ?? '').toLowerCase()
      );
      if (idx < 0) return;
      workingHeaders.splice(idx, 1);
      syncHeaders();
    },
    each: (fn) => {
      if (typeof fn !== 'function') return;
      for (const h of workingHeaders) fn({ key: h.key, value: h.value });
    },
  };

  // --- query params (request.params) --------------------------------------
  const findWorkingParam = (name) =>
    workingParams.find((p) => p.key.toLowerCase() === String(name ?? '').toLowerCase());
  const paramsApi = {
    all: () => workingParams.map((p) => ({ key: p.key, value: p.value })),
    get: (name) => {
      const hit = findWorkingParam(name);
      return hit ? hit.value : undefined;
    },
    has: (name) => Boolean(findWorkingParam(name)),
    add: (input) => {
      const entry = toParamEntry(input);
      if (!entry) return;
      workingParams.push(entry);
      removedParams.delete(entry.key.toLowerCase());
      syncParams();
    },
    upsert: (input) => {
      const entry = toParamEntry(input);
      if (!entry) return;
      const existing = findWorkingParam(entry.key);
      if (existing) Object.assign(existing, entry);
      else workingParams.push(entry);
      removedParams.delete(entry.key.toLowerCase());
      syncParams();
    },
    remove: (name) => {
      const key = String(name ?? '').toLowerCase();
      const idx = workingParams.findIndex((p) => p.key.toLowerCase() === key);
      if (idx >= 0) workingParams.splice(idx, 1);
      removedParams.add(key);
      syncParams();
    },
    clear: () => {
      for (const p of workingParams) removedParams.add(p.key.toLowerCase());
      workingParams.length = 0;
      syncParams();
    },
    each: (fn) => {
      if (typeof fn !== 'function') return;
      for (const p of workingParams) fn({ key: p.key, value: p.value });
    },
  };

  // --- path variables (:id) ----------------------------------------------
  const findWorkingPathVar = (name) =>
    workingPathVars.find((p) => p.key === String(name ?? ''));
  const pathVarsApi = {
    all: () => workingPathVars.map((p) => ({ key: p.key, value: p.value })),
    get: (name) => {
      const hit = findWorkingPathVar(name);
      return hit ? hit.value : undefined;
    },
    has: (name) => Boolean(findWorkingPathVar(name)),
    toObject: () => {
      const out = {};
      for (const p of workingPathVars) out[p.key] = p.value;
      return out;
    },
    add: (input) => {
      const entry = toPathVarEntry(input);
      if (!entry) return;
      workingPathVars.push(entry);
      removedPathVars.delete(entry.key);
      syncPathVars();
    },
    upsert: (input) => {
      const entry = toPathVarEntry(input);
      if (!entry) return;
      const existing = findWorkingPathVar(entry.key);
      if (existing) existing.value = entry.value;
      else workingPathVars.push(entry);
      removedPathVars.delete(entry.key);
      syncPathVars();
    },
    remove: (name) => {
      const key = String(name ?? '');
      const idx = workingPathVars.findIndex((p) => p.key === key);
      if (idx >= 0) workingPathVars.splice(idx, 1);
      removedPathVars.add(key);
      syncPathVars();
    },
  };

  // --- body ---------------------------------------------------------------
  const formApi = (mode) => ({
    all: () => bodyState.form.map((f) => ({ key: f.key, value: f.value })),
    get: (name) => {
      const hit = bodyState.form.find(
        (f) => String(f.key ?? '').toLowerCase() === String(name ?? '').toLowerCase()
      );
      return hit ? hit.value : undefined;
    },
    has: (name) =>
      bodyState.form.some(
        (f) => String(f.key ?? '').toLowerCase() === String(name ?? '').toLowerCase()
      ),
    add: (input) => {
      const entry = toFormEntry(input);
      if (!entry) return;
      bodyState.form.push(entry);
      bodyState.mode = mode;
      syncBody();
    },
    upsert: (input) => {
      const entry = toFormEntry(input);
      if (!entry) return;
      const existing = bodyState.form.find(
        (f) => String(f.key ?? '').toLowerCase() === entry.key.toLowerCase()
      );
      if (existing) Object.assign(existing, entry);
      else bodyState.form.push(entry);
      bodyState.mode = mode;
      syncBody();
    },
    remove: (name) => {
      const key = String(name ?? '').toLowerCase();
      const idx = bodyState.form.findIndex(
        (f) => String(f.key ?? '').toLowerCase() === key
      );
      if (idx < 0) return;
      bodyState.form.splice(idx, 1);
      syncBody();
    },
  });

  const bodyApi = {
    get mode() {
      return bodyState.mode;
    },
    set mode(value) {
      bodyState.mode = String(value);
      syncBody();
    },
    get raw() {
      return bodyState.raw;
    },
    set raw(value) {
      bodyState.raw = value == null ? '' : String(value);
      syncBody();
    },
    get form() {
      return bodyState.form.map((f) => ({ ...f }));
    },
    // pm.request.body.update(raw) or update({ mode, raw, form })
    update(next) {
      if (typeof next === 'string') {
        bodyState.raw = next;
        bodyState.mode = 'raw';
      } else if (next && typeof next === 'object') {
        if (next.mode != null) bodyState.mode = String(next.mode);
        if (next.raw != null) bodyState.raw = String(next.raw);
        if (Array.isArray(next.form)) bodyState.form = next.form.map((f) => ({ ...f }));
      }
      syncBody();
    },
    urlencoded: formApi('form-urlencoded'),
    formdata: formApi('form-data'),
  };

  // --- url ----------------------------------------------------------------
  function setUrl(value) {
    if (value == null) return;
    if (typeof value === 'string') {
      state.url = value;
      patch.url = value;
      return;
    }
    if (typeof value !== 'object') return;
    // String objects (including our own url view) report as objects.
    const raw = typeof value.raw === 'string' ? value.raw : assembleUrlFromObject(value);
    state.url = raw;
    patch.url = raw;
    if (Array.isArray(value.query)) {
      for (const q of value.query) paramsApi.upsert(q);
    }
    if (Array.isArray(value.variable)) {
      for (const v of value.variable) pathVarsApi.upsert(v);
    }
  }

  // A String object keeps legacy scripts working (`pm.request.url.indexOf(...)`,
  // `pm.request.url === 'https://...'` via valueOf) while exposing Postman's
  // url methods. A fresh view is created per read so `raw`/`toString` are never
  // stale after a mutation.
  function makeUrlView() {
    const view = new String(state.url);
    Object.defineProperty(view, 'raw', {
      enumerable: true,
      get: () => state.url,
      set: (next) => {
        setUrl(next);
      },
    });
    Object.defineProperty(view, 'query', { enumerable: true, get: () => paramsApi });
    Object.defineProperty(view, 'variables', { enumerable: true, get: () => pathVarsApi });
    view.toString = () => state.url;
    view.valueOf = () => state.url;
    view.update = (next) => setUrl(next);
    view.addQueryParams = (list) => {
      for (const q of list || []) paramsApi.add(q);
    };
    view.getBaseUrl = () => state.url.split('?')[0];
    return view;
  }

  const api = {
    get method() {
      return state.method;
    },
    set method(value) {
      state.method = String(value ?? '').toUpperCase();
      patch.method = state.method;
    },
    get url() {
      return makeUrlView();
    },
    set url(value) {
      setUrl(value);
    },
    headers: headersApi,
    query: paramsApi,
    pathVars: pathVarsApi,
    body: bodyApi,
    addHeader: (input) => headersApi.add(input),
    removeHeader: (name) => headersApi.remove(name),
    addQueryParams: (list) => {
      for (const q of list || []) paramsApi.add(q);
    },
  };

  return api;
}
