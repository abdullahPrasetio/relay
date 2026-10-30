// Convert between our internal collection shape and the Postman Collection
// Format v2.1, so collections can be exchanged with real Postman.
//
// Fidelity notes:
// - Scripts exist on collection, folder, and request nodes. Postman stores
//   them as `event[]` on the same level, so every node maps 1:1.
// - Saved examples are Postman `item.response[]` entries; we keep the relay
//   only fields (`_relayId`, `_relaySavedAt`) so a round-trip does not mint
//   new identities.
// - `pathVars` map to `url.variable[]`. Query params that already appear in
//   `url.raw` are deduped by key+value in both directions.
import { newRequest, newCollection, newAuth, uid } from './factory.js';
import { newFolder } from './collectionTree.js';
import { toPostmanEnvironment, fromPostmanEnvironment } from './environmentFormat.js';

const COLLECTION_SCHEMA =
  'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

export const WORKSPACE_BACKUP_VERSION = 1;

// ---- EXPORT: internal collection -> Postman v2.1 ----
export function toPostmanCollection(collection) {
  const out = {
    info: {
      _postman_id: collection.id,
      name: collection.name,
      schema: COLLECTION_SCHEMA,
    },
    item: (collection.items || []).map(nodeToPostman),
  };
  const description = descriptionForExport(collection.description);
  if (description !== undefined) out.info.description = description;
  if (collection.variables && collection.variables.length) {
    out.variable = collection.variables
      .filter((v) => v && v.key)
      .map((v) =>
        v.type === 'secret'
          ? { key: v.key, value: '', type: 'secret', disabled: v.enabled === false }
          : { key: v.key, value: v.value ?? '', disabled: v.enabled === false }
      );
  }
  const colAuth = authToPostman(collection.auth);
  if (colAuth) out.auth = colAuth;
  const events = scriptsToEvents(collection);
  if (events.length) out.event = events;
  return out;
}

// Build Postman event[] from pre-request/test scripts of any tree node.
function scriptsToEvents(src) {
  const events = [];
  if (src.preRequest && src.preRequest.trim()) {
    events.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: src.preRequest.split('\n') } });
  }
  if (src.tests && src.tests.trim()) {
    events.push({ listen: 'test', script: { type: 'text/javascript', exec: src.tests.split('\n') } });
  }
  return events;
}

function nodeToPostman(node) {
  if (node.type === 'folder') {
    const item = { name: node.name || 'Folder' };
    const description = descriptionForExport(node.description);
    if (description !== undefined) item.description = description;
    const auth = authToPostman(node.auth);
    if (auth) item.auth = auth;
    const events = scriptsToEvents(node);
    if (events.length) item.event = events;
    item.item = (node.items || []).map(nodeToPostman);
    return item;
  }
  return requestToItem(node);
}

function requestToItem(req) {
  const item = {
    name: req.name || req.url || 'Request',
    request: {
      method: req.method || 'GET',
      header: headersToPostman(req.headers),
      url: urlToPostman(req.url, req.params, req.pathVars),
    },
  };

  // Postman keeps a request's description on the item, though some exports
  // nest it under `request`; we read both on import.
  const description = descriptionForExport(req.description);
  if (description !== undefined) item.description = description;

  const body = bodyToPostman(req.body);
  if (body) item.request.body = body;

  const auth = authToPostman(req.auth);
  if (auth) item.request.auth = auth;

  const events = scriptsToEvents(req);
  if (events.length) item.event = events;

  const responses = (req.examples || [])
    .filter(Boolean)
    .map(exampleToPostman)
    .filter(Boolean);
  if (responses.length) item.response = responses;

  return item;
}

function urlToPostman(rawUrl, params, pathVars) {
  const { base, pairs } = splitRawQuery(rawUrl);
  const seen = pairs.map((p) => tokenOf(p.key, p.value));
  const segments = pairs.map((p) => p.text);

  for (const p of params || []) {
    if (!p || !p.key || p.enabled === false) continue;
    const value = p.value ?? '';
    const token = tokenOf(p.key, value);
    // The raw URL already carries this pair (Postman often keeps both raw and
    // query[] in sync): skip it instead of emitting `?a=1&a=1`.
    const duplicate = seen.indexOf(token);
    if (duplicate >= 0) {
      seen.splice(duplicate, 1);
      continue;
    }
    segments.push(`${p.key}=${value}`);
  }

  const raw = segments.length ? `${base}?${segments.join('&')}` : base;
  const out = {
    raw,
    query: (params || [])
      .filter((p) => p && p.key)
      .map((p) => ({ key: p.key, value: p.value ?? '', disabled: p.enabled === false })),
  };
  const variables = (pathVars || [])
    .filter((v) => v && v.key)
    .map((v) => ({ key: v.key, value: v.value ?? '', disabled: v.enabled === false }));
  if (variables.length) out.variable = variables;
  return out;
}

// Split `https://x/a?b=1&c=2` into base and pairs, keeping each pair's raw
// text so we can re-emit the URL without re-encoding it.
function splitRawQuery(raw) {
  const source = String(raw || '');
  const qIndex = source.indexOf('?');
  if (qIndex < 0) return { base: source, pairs: [] };
  const query = source.slice(qIndex + 1).split('#')[0];
  const pairs = query
    .split('&')
    .filter(Boolean)
    .map((text) => {
      const eq = text.indexOf('=');
      return eq < 0
        ? { key: text, value: '', text }
        : { key: text.slice(0, eq), value: text.slice(eq + 1), text };
    });
  return { base: source.slice(0, qIndex), pairs };
}

function tokenOf(key, value) {
  return `${key}\u0000${value}`;
}

function bodyToPostman(body) {
  if (!body || body.mode === 'none') return null;
  if (body.mode === 'json' || body.mode === 'raw') {
    return {
      mode: 'raw',
      raw: body.raw || '',
      options: body.mode === 'json' ? { raw: { language: 'json' } } : undefined,
    };
  }
  if (body.mode === 'form-urlencoded') {
    return {
      mode: 'urlencoded',
      urlencoded: (body.form || []).map((f) => ({
        key: f.key,
        value: f.value,
        disabled: f.enabled === false,
      })),
    };
  }
  if (body.mode === 'form-data') {
    return {
      mode: 'formdata',
      formdata: (body.form || []).map((f) => formFieldToPostman(f)),
    };
  }
  return null;
}

function formFieldToPostman(f) {
  if (f.type === 'file') {
    const field = {
      key: f.key,
      type: 'file',
      src: f.filePath ? [f.filePath] : [],
      disabled: f.enabled === false,
    };
    if (f.contentType) field.contentType = f.contentType;
    return field;
  }
  const field = {
    key: f.key,
    value: f.value ?? '',
    type: 'text',
    disabled: f.enabled === false,
  };
  if (f.contentType) field.contentType = f.contentType;
  return field;
}

// ---- auth ----
// Postman auth is `{ type, <type>: [{ key, value, type: 'string', disabled? }] }`.
//
// Some of our auth families have no Postman equivalent (`jwt`) or carry extra
// internal fields (`oauth1.addTo`, `oauth1.version`, `awsv4.addTo`,
// `oauth2.headerPrefix`, `jwt.privateKey`). Those are emitted as additional
// attribute rows: Postman ignores unknown keys, and our importer reads them
// back, so an export/import round-trip stays lossless for our own data.
//
// Our auth attributes have no enabled switch, so a `disabled: true` row is
// treated as absent on import and is never emitted on export: Postman-side
// disabling cannot be represented internally without inventing an `enabled`
// field, which is out of scope here.
function authAttribute(key, value) {
  return { key, value: value == null ? '' : String(value), type: 'string' };
}

function authToPostman(auth) {
  if (!auth || auth.type === 'none' || auth.type === 'inherit') return null;
  if (auth.type === 'bearer') {
    return { type: 'bearer', bearer: [authAttribute('token', auth.bearer?.token)] };
  }
  if (auth.type === 'basic') {
    return {
      type: 'basic',
      basic: [
        authAttribute('username', auth.basic?.username),
        authAttribute('password', auth.basic?.password),
      ],
    };
  }
  if (auth.type === 'apikey') {
    return {
      type: 'apikey',
      apikey: [
        authAttribute('key', auth.apikey?.key),
        authAttribute('value', auth.apikey?.value),
        authAttribute('in', auth.apikey?.addTo === 'query' ? 'query' : 'header'),
      ],
    };
  }
  if (auth.type === 'oauth1') {
    const o = auth.oauth1 || {};
    return {
      type: 'oauth1',
      oauth1: [
        authAttribute('consumerKey', o.consumerKey),
        authAttribute('consumerSecret', o.consumerSecret),
        authAttribute('token', o.token),
        authAttribute('tokenSecret', o.tokenSecret),
        authAttribute('signatureMethod', o.signatureMethod || 'HMAC-SHA1'),
        authAttribute('realm', o.realm),
        authAttribute('addTo', o.addTo === 'query' ? 'query' : 'header'),
        authAttribute('version', o.version || '1.0'),
      ],
    };
  }
  if (auth.type === 'oauth2') {
    const o = auth.oauth2 || {};
    return {
      type: 'oauth2',
      oauth2: [
        authAttribute('accessToken', o.accessToken),
        authAttribute('tokenType', o.tokenType || 'Bearer'),
        // We only ever attach the token to the Authorization header.
        authAttribute('addTokenTo', 'header'),
        authAttribute('authUrl', o.authUrl),
        authAttribute('accessTokenUrl', o.accessTokenUrl),
        authAttribute('scope', o.scope),
        authAttribute('audience', o.audience),
        authAttribute('clientId', o.clientId),
        authAttribute('clientSecret', o.clientSecret),
        authAttribute('grant_type', o.grantType || 'client_credentials'),
        authAttribute('refreshToken', o.refreshToken),
        authAttribute('headerPrefix', o.headerPrefix || 'Bearer'),
      ],
    };
  }
  if (auth.type === 'digest') {
    const d = auth.digest || {};
    return {
      type: 'digest',
      digest: [
        authAttribute('username', d.username),
        authAttribute('password', d.password),
        authAttribute('algorithm', d.algorithm || 'MD5'),
        // Digest signing is challenge-driven internally; no qop is stored.
        authAttribute('qop', d.qop || 'auth'),
      ],
    };
  }
  if (auth.type === 'ntlm') {
    const n = auth.ntlm || {};
    return {
      type: 'ntlm',
      ntlm: [
        authAttribute('username', n.username),
        authAttribute('password', n.password),
        authAttribute('domain', n.domain),
        authAttribute('workstation', n.workstation),
      ],
    };
  }
  if (auth.type === 'awsv4') {
    const a = auth.awsv4 || {};
    return {
      type: 'awsv4',
      awsv4: [
        authAttribute('accessKey', a.accessKey),
        authAttribute('secretKey', a.secretKey),
        authAttribute('region', a.region),
        authAttribute('service', a.service),
        authAttribute('sessionToken', a.sessionToken),
        authAttribute('addTo', a.addTo === 'query' ? 'query' : 'header'),
      ],
    };
  }
  if (auth.type === 'jwt') {
    const j = auth.jwt || {};
    const algorithm = j.algorithm || 'HS256';
    const header = { alg: algorithm, typ: 'JWT' };
    if (j.kid) header.kid = j.kid;
    return {
      type: 'jwt', // Not a Postman auth type; round-trips through Relay only.
      jwt: [
        authAttribute('algorithm', algorithm),
        authAttribute('secret', j.secret),
        authAttribute('privateKey', j.privateKey),
        authAttribute('payload', j.payload),
        authAttribute('header', JSON.stringify(header)),
        authAttribute('headerPrefix', j.headerPrefix || 'Bearer'),
      ],
    };
  }
  return null;
}

function headersToPostman(headers) {
  return (headers || [])
    .filter((h) => h && h.key)
    .map((h) => ({ key: h.key, value: h.value ?? '', disabled: h.enabled === false }));
}

// ---- examples (request/response snapshots) ----
function exampleToPostman(example) {
  const req = example.request || {};
  const resp = example.response || {};
  const originalRequest = {
    method: req.method || 'GET',
    header: headersToPostman(req.headers),
    url: { raw: String(req.url || '') },
  };
  const body = bodyToPostman(req.body);
  if (body) originalRequest.body = body;

  const headers = headersToPostman(resp.headers);
  const out = {
    name: example.name || 'Example',
    originalRequest,
    status: resp.statusText || '',
    code: typeof resp.status === 'number' ? resp.status : 0,
    header: headers,
    body: resp.body ?? '',
  };
  // Keep relay-only fields so import -> export -> import is lossless.
  if (example.id) out._relayId = example.id;
  if (example.savedAt) out._relaySavedAt = example.savedAt;
  if (resp.contentType && !headerValue(headers, 'content-type')) {
    out._relayContentType = resp.contentType;
  }
  return out;
}

function headerValue(headers, name) {
  const wanted = name.toLowerCase();
  const hit = (headers || []).find((h) => String(h.key || '').toLowerCase() === wanted);
  return hit ? hit.value : '';
}

// ---- IMPORT: Postman v2.1 -> internal collection ----
export function fromPostmanCollection(json) {
  const name = json?.info?.name || 'Imported Collection';
  const collection = newCollection(name);
  collection.id = json?.info?._postman_id || collection.id;
  collection.description = descriptionToText(json?.info?.description);
  delete collection.requests;
  collection.variables = (json?.variable || []).map((v) => {
    const row = {
      key: v.key || '',
      value: v.value ?? '',
      enabled: v.disabled !== true,
    };
    if (v.type === 'secret') {
      row.type = 'secret';
      row.value = '';
    }
    return row;
  });
  const colAuth = fromPostmanAuth(json?.auth);
  // Collections cannot inherit: no auth, `noauth`, or an unknown type all
  // leave the collection default (`{ ...newAuth(), type: 'none' }`).
  if (json?.auth && colAuth.type !== 'none' && colAuth.type !== 'inherit') {
    collection.auth = colAuth;
  }
  const colScripts = eventsToScripts(json?.event);
  collection.preRequest = colScripts.preRequest;
  collection.tests = colScripts.tests;
  collection.items = (json?.item || []).map(itemToNode);
  // Imported code is untrusted until the user explicitly allows it, so the
  // UI can ask once before running any collection/folder/request script.
  if (hasAnyScript(collection)) collection.scriptsTrusted = false;
  return collection;
}

function hasAnyScript(node) {
  if (!node) return false;
  if (typeof node.preRequest === 'string' && node.preRequest.trim()) return true;
  if (typeof node.tests === 'string' && node.tests.trim()) return true;
  if (Array.isArray(node.items)) return node.items.some(hasAnyScript);
  return false;
}

// Extract pre-request/test scripts from a Postman event[].
function eventsToScripts(events) {
  const out = { preRequest: '', tests: '' };
  for (const e of events || []) {
    const body = Array.isArray(e.script?.exec)
      ? e.script.exec.join('\n')
      : String(e.script?.exec || '');
    if (e.listen === 'prerequest') out.preRequest = body;
    if (e.listen === 'test') out.tests = body;
  }
  return out;
}

function itemToNode(item) {
  if (Array.isArray(item.item)) {
    const folder = newFolder(item.name || 'Folder');
    folder.description = descriptionToText(item.description);
    folder.auth = item.auth ? fromPostmanAuth(item.auth) : null;
    const scripts = eventsToScripts(item.event);
    folder.preRequest = scripts.preRequest;
    folder.tests = scripts.tests;
    folder.items = item.item.map(itemToNode);
    return folder;
  }
  return { ...itemToRequest(item), type: 'request' };
}

function itemToRequest(item) {
  const r = item.request || {};
  const req = newRequest({
    id: uid('req'),
    name: item.name || 'Request',
    method: (typeof r.method === 'string' ? r.method : 'GET').toUpperCase(),
  });

  // Description lives on the item, but some exports nest it under request.
  req.description = descriptionToText(item.description ?? r.description);

  // URL, query params, and path variables.
  const urlInfo = parsePostmanUrl(r.url);
  req.url = urlInfo.url;
  req.params = urlInfo.params;
  req.pathVars = urlInfo.pathVars;

  // Headers
  req.headers = headersFromPostman(r.header);

  // Body
  req.body = parsePostmanBody(r.body);

  // Auth: a missing request auth means "inherit the parent" in Postman.
  req.auth = r.auth ? fromPostmanAuth(r.auth) : { ...newAuth(), type: 'inherit' };

  // Scripts (pre-request and tests live on the same item.event array).
  const scripts = eventsToScripts(item.event);
  req.preRequest = scripts.preRequest;
  req.tests = scripts.tests;

  // Saved examples.
  req.examples = Array.isArray(item.response)
    ? item.response.map((response, index) => responseToExample(response, index))
    : [];

  return req;
}

function responseToExample(response, index) {
  const r = response || {};
  const original = r.originalRequest || {};
  const headers = headersFromPostman(r.header);
  const contentType =
    headerValue(r.header, 'content-type') ||
    (typeof r._relayContentType === 'string' ? r._relayContentType : '');
  return {
    id: typeof r._relayId === 'string' && r._relayId ? r._relayId : uid('ex'),
    name: r.name || `Example ${index + 1}`,
    savedAt: typeof r._relaySavedAt === 'string' ? r._relaySavedAt : null,
    request: {
      method: (typeof original.method === 'string' ? original.method : 'GET').toUpperCase(),
      url: exampleUrlFromPostman(original.url),
      headers: headersFromPostman(original.header),
      body: parsePostmanBody(original.body),
    },
    response: {
      status: typeof r.code === 'number' ? r.code : 0,
      statusText: typeof r.status === 'string' ? r.status : '',
      headers,
      body: typeof r.body === 'string' ? r.body : '',
      contentType,
    },
  };
}

function exampleUrlFromPostman(url) {
  if (!url) return '';
  if (typeof url === 'string') return url;
  if (typeof url.raw === 'string' && url.raw) return url.raw;
  // Some exporters omit `raw` but provide protocol/host/path.
  const protocol = url.protocol ? `${url.protocol}://` : '';
  const host = Array.isArray(url.host) ? url.host.join('.') : url.host || '';
  const port = url.port ? `:${url.port}` : '';
  const pathParts = Array.isArray(url.path) ? url.path : [];
  const path = pathParts.length ? `/${pathParts.join('/')}` : '';
  return `${protocol}${host}${port}${path}`;
}

function parsePostmanUrl(url) {
  if (!url) return { url: '', params: [], pathVars: [] };
  if (typeof url === 'string') {
    const { base, pairs } = splitRawQuery(url);
    return {
      url: base,
      params: pairs.map((p) => ({ key: p.key, value: p.value, enabled: true })),
      pathVars: [],
    };
  }
  const { base, pairs } = splitRawQuery(url.raw || '');
  const params = (url.query || []).map((q) => ({
    key: q.key || '',
    value: q.value || '',
    enabled: q.disabled !== true,
  }));
  // Imports that only carry a raw URL still keep their query params usable.
  for (const p of pairs) {
    const token = tokenOf(p.key, p.value);
    if (!params.some((q) => tokenOf(q.key, q.value) === token)) {
      params.push({ key: p.key, value: p.value, enabled: true });
    }
  }
  const pathVars = (url.variable || [])
    .filter((v) => v && v.key)
    .map((v) => ({ key: v.key, value: v.value != null ? String(v.value) : '' }));
  return { url: base, params, pathVars };
}

function headersFromPostman(headers) {
  return (headers || [])
    .filter((h) => h && h.key)
    .map((h) => ({ key: h.key, value: h.value ?? '', enabled: h.disabled !== true }));
}

function parsePostmanBody(body) {
  const base = { mode: 'none', raw: '', form: [] };
  if (!body) return base;
  if (body.mode === 'raw') {
    const isJson = body.options?.raw?.language === 'json';
    return { ...base, mode: isJson ? 'json' : 'raw', raw: body.raw || '' };
  }
  if (body.mode === 'urlencoded') {
    return {
      ...base,
      mode: 'form-urlencoded',
      form: (body.urlencoded || []).map((f) => ({
        key: f.key || '',
        value: f.value || '',
        enabled: f.disabled !== true,
      })),
    };
  }
  if (body.mode === 'formdata') {
    return {
      ...base,
      mode: 'form-data',
      form: (body.formdata || []).map(parseFormField),
    };
  }
  return base;
}

function parseFormField(f) {
  if (f.type === 'file') {
    const src = Array.isArray(f.src) ? f.src[0] : f.src;
    const filePath = typeof src === 'string' ? src : '';
    return {
      key: f.key || '',
      type: 'file',
      filePath,
      fileName: fileBaseName(filePath),
      contentType: f.contentType || '',
      enabled: f.disabled !== true,
    };
  }
  const field = {
    key: f.key || '',
    value: f.value ?? '',
    type: 'text',
    enabled: f.disabled !== true,
  };
  if (f.contentType) field.contentType = f.contentType;
  return field;
}

function fileBaseName(filePath) {
  if (!filePath) return '';
  return String(filePath).split(/[\\/]/).pop();
}

function fromPostmanAuth(auth) {
  const base = newAuth();
  if (!auth || typeof auth !== 'object' || !auth.type) {
    // No auth object means "inherit from the parent" in Postman.
    return { ...base, type: 'inherit' };
  }
  const type = String(auth.type).toLowerCase();
  const rows = Array.isArray(auth[type]) ? auth[type] : [];
  const read = (key) => {
    const row = rows.find((r) => r && r.key === key && r.disabled !== true);
    return row && row.value != null ? String(row.value) : null;
  };
  const value = (key, fallback = '') => {
    const v = read(key);
    return v == null ? fallback : v;
  };

  if (type === 'noauth') return { ...base, type: 'none' };
  if (type === 'bearer') {
    return { ...base, type: 'bearer', bearer: { token: value('token') } };
  }
  if (type === 'basic') {
    return {
      ...base,
      type: 'basic',
      basic: { username: value('username'), password: value('password') },
    };
  }
  if (type === 'apikey') {
    return {
      ...base,
      type: 'apikey',
      apikey: {
        key: value('key'),
        value: value('value'),
        addTo: value('in') === 'query' ? 'query' : 'header',
      },
    };
  }
  if (type === 'oauth1') {
    return {
      ...base,
      type: 'oauth1',
      oauth1: {
        ...base.oauth1,
        consumerKey: value('consumerKey'),
        consumerSecret: value('consumerSecret'),
        token: value('token'),
        tokenSecret: value('tokenSecret'),
        signatureMethod: value('signatureMethod', base.oauth1.signatureMethod),
        realm: value('realm'),
        addTo: value('addTo') === 'query' ? 'query' : 'header',
        version: value('version', base.oauth1.version),
      },
    };
  }
  if (type === 'oauth2') {
    const tokenType = value('tokenType', base.oauth2.tokenType);
    return {
      ...base,
      type: 'oauth2',
      oauth2: {
        ...base.oauth2,
        accessToken: value('accessToken'),
        tokenType,
        authUrl: value('authUrl'),
        accessTokenUrl: value('accessTokenUrl'),
        scope: value('scope'),
        audience: value('audience'),
        clientId: value('clientId'),
        clientSecret: value('clientSecret'),
        grantType: value('grant_type', base.oauth2.grantType),
        refreshToken: value('refreshToken'),
        // Postman has no separate prefix; `tokenType` plays that role.
        headerPrefix: value('headerPrefix', tokenType),
      },
    };
  }
  if (type === 'digest') {
    return {
      ...base,
      type: 'digest',
      digest: {
        username: value('username'),
        password: value('password'),
        algorithm: value('algorithm', base.digest.algorithm),
      },
    };
  }
  if (type === 'ntlm') {
    return {
      ...base,
      type: 'ntlm',
      ntlm: {
        username: value('username'),
        password: value('password'),
        domain: value('domain'),
        workstation: value('workstation'),
      },
    };
  }
  if (type === 'awsv4') {
    return {
      ...base,
      type: 'awsv4',
      awsv4: {
        ...base.awsv4,
        accessKey: value('accessKey'),
        secretKey: value('secretKey'),
        region: value('region'),
        service: value('service'),
        sessionToken: value('sessionToken'),
        addTo: value('addTo') === 'query' ? 'query' : 'header',
      },
    };
  }
  if (type === 'jwt') {
    // `header` is a JSON string; our model only keeps `alg` and `kid` from it.
    let header = {};
    const rawHeader = read('header');
    if (rawHeader) {
      try {
        const parsed = JSON.parse(rawHeader);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) header = parsed;
      } catch {
        header = {};
      }
    }
    const algorithm =
      read('algorithm') || (typeof header.alg === 'string' ? header.alg : base.jwt.algorithm);
    const kid = header.kid != null ? String(header.kid) : value('kid', base.jwt.kid);
    return {
      ...base,
      type: 'jwt',
      jwt: {
        ...base.jwt,
        algorithm,
        secret: value('secret'),
        privateKey: value('privateKey'),
        payload: value('payload', base.jwt.payload),
        kid,
        headerPrefix: value('headerPrefix', base.jwt.headerPrefix),
      },
    };
  }
  // Unknown Postman auth type (e.g. hawk/edgegrid): fall back to inherit
  // instead of throwing, so an otherwise valid collection still imports.
  return { ...base, type: 'inherit' };
}

// ---- descriptions ----
// Postman descriptions can be a string or `{ content, type }`.
function descriptionToText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.content === 'string') return value.content;
  return '';
}

function descriptionForExport(value) {
  if (value == null || value === '') return undefined;
  if (typeof value === 'string' || typeof value === 'object') return value;
  return undefined;
}

// ---- globals + workspace backup ----
export function toPostmanGlobals(globals) {
  return {
    name: 'Globals',
    values: (globals || [])
      .filter((v) => v && v.key)
      .map((v) =>
        v.type === 'secret'
          ? { key: v.key, value: '', type: 'secret', enabled: v.enabled !== false }
          : { key: v.key, value: v.value ?? '', type: 'default', enabled: v.enabled !== false }
      ),
    _postman_variable_scope: 'globals',
  };
}

export function fromPostmanGlobals(json) {
  const values = Array.isArray(json?.values) ? json.values : Array.isArray(json) ? json : [];
  return values
    .filter((v) => v && v.key)
    .map((v) => {
      const row = {
        key: v.key,
        value: v.value ?? '',
        enabled: v.enabled !== false,
      };
      if (v.type === 'secret') {
        row.type = 'secret';
        row.value = '';
      }
      return row;
    });
}

// Relay-only collection metadata (Confluence destination). Kept beside the
// Postman payload for workspace backups; normal Postman exports never include
// it. Credentials are main-owned and are deliberately absent.
function confluenceBackupMeta(collection) {
  const c = collection || {};
  const meta = {
    pageId: c.confluencePageId || '',
    pageUrl: c.confluencePageUrl || '',
    title: c.confluenceTitle || '',
    spaceKey: c.confluenceSpaceKey || '',
    parentPageId: c.confluenceParentPageId || '',
    syncedAt: c.confluenceSyncedAt || null,
    version: c.confluenceVersion ?? null,
  };
  return Object.values(meta).some((value) => value != null && value !== '') ? meta : null;
}

function applyConfluenceBackupMeta(collection, meta) {
  if (!collection || !meta || typeof meta !== 'object') return collection;
  if (typeof meta.pageId === 'string') collection.confluencePageId = meta.pageId;
  if (typeof meta.pageUrl === 'string') collection.confluencePageUrl = meta.pageUrl;
  if (typeof meta.title === 'string') collection.confluenceTitle = meta.title;
  if (typeof meta.spaceKey === 'string') collection.confluenceSpaceKey = meta.spaceKey;
  if (typeof meta.parentPageId === 'string') {
    collection.confluenceParentPageId = meta.parentPageId;
  }
  if (typeof meta.syncedAt === 'string' || meta.syncedAt == null) {
    collection.confluenceSyncedAt = meta.syncedAt;
  }
  if (Number.isInteger(meta.version) && meta.version > 0) {
    collection.confluenceVersion = meta.version;
  }
  return collection;
}

// A full workspace snapshot that keeps collections, environments, and globals
// together. The `_relayBackup` marker lets `fromWorkspaceBackup` reject JSON
// that is not one of our backups.
export function toWorkspaceBackup(workspace) {
  return {
    _relayBackup: { format: 'relay-workspace', version: WORKSPACE_BACKUP_VERSION },
    name: workspace?.name || 'Workspace',
    collections: (workspace?.collections || []).map((collection) => {
      const out = toPostmanCollection(collection);
      const meta = confluenceBackupMeta(collection);
      if (meta) out._relayConfluence = meta;
      return out;
    }),
    environments: (workspace?.environments || []).map(toPostmanEnvironment),
    globals: toPostmanGlobals(workspace?.globals || []),
  };
}

export function fromWorkspaceBackup(json) {
  if (!json || !json._relayBackup) return null;
  return {
    name: json.name || 'Restored Workspace',
    collections: (json.collections || []).map((raw) =>
      applyConfluenceBackupMeta(fromPostmanCollection(raw), raw?._relayConfluence)
    ),
    environments: (json.environments || []).map(fromPostmanEnvironment),
    globals: fromPostmanGlobals(json.globals),
  };
}
