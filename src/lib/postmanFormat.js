// Convert between our internal collection shape and the Postman Collection
// Format v2.1, so collections can be exchanged with real Postman.
import { newRequest, newCollection, newAuth, uid } from './factory.js';
import { newFolder } from './collectionTree.js';

// ---- EXPORT: internal collection -> Postman v2.1 ----
export function toPostmanCollection(collection) {
  const out = {
    info: {
      _postman_id: collection.id,
      name: collection.name,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: (collection.items || []).map(nodeToPostman),
  };
  if (collection.description) {
    out.info.description = collection.description;
  }
  if (collection.variables && collection.variables.length) {
    out.variable = collection.variables
      .filter((v) => v.key)
      .map((v) => ({ key: v.key, value: v.value, disabled: v.enabled === false }));
  }
  const colAuth = authToPostman(collection.auth);
  if (colAuth) out.auth = colAuth;
  const events = scriptsToEvents(collection);
  if (events.length) out.event = events;
  return out;
}

// Build Postman event[] from pre-request/test scripts.
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
    return { name: node.name, item: (node.items || []).map(nodeToPostman) };
  }
  return requestToItem(node);
}

function requestToItem(req) {
  const item = {
    name: req.name || req.url || 'Request',
    request: {
      method: req.method || 'GET',
      header: (req.headers || [])
        .filter((h) => h.key)
        .map((h) => ({ key: h.key, value: h.value, disabled: h.enabled === false })),
      url: urlToPostman(req.url, req.params),
    },
  };

  const body = bodyToPostman(req.body);
  if (body) item.request.body = body;

  const auth = authToPostman(req.auth);
  if (auth) item.request.auth = auth;

  if (req.tests && req.tests.trim()) {
    item.event = [
      {
        listen: 'test',
        script: { type: 'text/javascript', exec: req.tests.split('\n') },
      },
    ];
  }
  return item;
}

function urlToPostman(rawUrl, params) {
  const raw =
    (rawUrl || '') +
    buildQueryString(params);
  return {
    raw,
    query: (params || [])
      .filter((p) => p.key)
      .map((p) => ({ key: p.key, value: p.value, disabled: p.enabled === false })),
  };
}

function buildQueryString(params) {
  const enabled = (params || []).filter((p) => p.enabled !== false && p.key);
  if (enabled.length === 0) return '';
  return '?' + enabled.map((p) => `${p.key}=${p.value ?? ''}`).join('&');
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
      formdata: (body.form || []).map((f) => ({
        key: f.key,
        value: f.value,
        type: 'text',
        disabled: f.enabled === false,
      })),
    };
  }
  return null;
}

function authToPostman(auth) {
  if (!auth || auth.type === 'none') return null;
  if (auth.type === 'bearer') {
    return { type: 'bearer', bearer: [{ key: 'token', value: auth.bearer?.token || '' }] };
  }
  if (auth.type === 'basic') {
    return {
      type: 'basic',
      basic: [
        { key: 'username', value: auth.basic?.username || '' },
        { key: 'password', value: auth.basic?.password || '' },
      ],
    };
  }
  if (auth.type === 'apikey') {
    return {
      type: 'apikey',
      apikey: [
        { key: 'key', value: auth.apikey?.key || '' },
        { key: 'value', value: auth.apikey?.value || '' },
        { key: 'in', value: auth.apikey?.addTo === 'query' ? 'query' : 'header' },
      ],
    };
  }
  if (auth.type === 'oauth2') {
    const o = auth.oauth2 || {};
    return {
      type: 'oauth2',
      oauth2: [
        { key: 'accessToken', value: o.accessToken || '' },
        { key: 'tokenName', value: 'Access Token' },
        { key: 'grant_type', value: o.grantType || 'client_credentials' },
        { key: 'accessTokenUrl', value: o.accessTokenUrl || '' },
        { key: 'clientId', value: o.clientId || '' },
        { key: 'clientSecret', value: o.clientSecret || '' },
        { key: 'scope', value: o.scope || '' },
        { key: 'addTokenTo', value: 'header' },
      ],
    };
  }
  return null;
}

// ---- IMPORT: Postman v2.1 -> internal collection ----
export function fromPostmanCollection(json) {
  const name = json?.info?.name || 'Imported Collection';
  const collection = newCollection(name);
  collection.id = json?.info?._postman_id || collection.id;
  collection.description = json?.info?.description || '';
  delete collection.requests;
  collection.variables = (json?.variable || []).map((v) => ({
    key: v.key || '',
    value: v.value ?? '',
    enabled: v.disabled !== true,
  }));
  const colAuth = parsePostmanAuth(json?.auth);
  if (colAuth.type !== 'none') collection.auth = colAuth;
  const colScripts = eventsToScripts(json?.event);
  collection.preRequest = colScripts.preRequest;
  collection.tests = colScripts.tests;
  collection.items = (json?.item || []).map(itemToNode);
  return collection;
}

// Extract pre-request/test scripts from a Postman event[].
function eventsToScripts(events) {
  const out = { preRequest: '', tests: '' };
  for (const e of events || []) {
    const body = Array.isArray(e.script?.exec) ? e.script.exec.join('\n') : String(e.script?.exec || '');
    if (e.listen === 'prerequest') out.preRequest = body;
    if (e.listen === 'test') out.tests = body;
  }
  return out;
}

function itemToNode(item) {
  if (Array.isArray(item.item)) {
    const folder = newFolder(item.name || 'Folder');
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

  // URL + params
  const urlInfo = parsePostmanUrl(r.url);
  req.url = urlInfo.url;
  req.params = urlInfo.params;

  // Headers
  req.headers = (r.header || []).map((h) => ({
    key: h.key || '',
    value: h.value || '',
    enabled: h.disabled !== true,
  }));

  // Body
  req.body = parsePostmanBody(r.body);

  // Auth
  req.auth = parsePostmanAuth(r.auth);

  // Tests
  const testEvent = (item.event || []).find((e) => e.listen === 'test');
  if (testEvent?.script?.exec) {
    req.tests = Array.isArray(testEvent.script.exec)
      ? testEvent.script.exec.join('\n')
      : String(testEvent.script.exec);
  }

  return req;
}

function parsePostmanUrl(url) {
  if (!url) return { url: '', params: [] };
  if (typeof url === 'string') {
    return { url: stripQuery(url), params: [] };
  }
  const raw = url.raw || '';
  const params = (url.query || []).map((q) => ({
    key: q.key || '',
    value: q.value || '',
    enabled: q.disabled !== true,
  }));
  return { url: stripQuery(raw), params };
}

function stripQuery(raw) {
  const i = raw.indexOf('?');
  return i >= 0 ? raw.slice(0, i) : raw;
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
      form: (body.formdata || []).map((f) => ({
        key: f.key || '',
        value: f.value || '',
        enabled: f.disabled !== true,
      })),
    };
  }
  return base;
}

function parsePostmanAuth(auth) {
  const base = { ...newAuth(), type: 'none' };
  if (!auth) return base;
  const pick = (arr, key) => (arr || []).find((x) => x.key === key)?.value || '';
  if (auth.type === 'oauth2') {
    return {
      ...base,
      type: 'oauth2',
      oauth2: {
        ...base.oauth2,
        accessToken: pick(auth.oauth2, 'accessToken'),
        grantType: pick(auth.oauth2, 'grant_type') || 'client_credentials',
        accessTokenUrl: pick(auth.oauth2, 'accessTokenUrl'),
        clientId: pick(auth.oauth2, 'clientId'),
        clientSecret: pick(auth.oauth2, 'clientSecret'),
        scope: pick(auth.oauth2, 'scope'),
      },
    };
  }
  if (auth.type === 'bearer') {
    return { ...base, type: 'bearer', bearer: { token: pick(auth.bearer, 'token') } };
  }
  if (auth.type === 'basic') {
    return {
      ...base,
      type: 'basic',
      basic: { username: pick(auth.basic, 'username'), password: pick(auth.basic, 'password') },
    };
  }
  if (auth.type === 'apikey') {
    return {
      ...base,
      type: 'apikey',
      apikey: {
        key: pick(auth.apikey, 'key'),
        value: pick(auth.apikey, 'value'),
        addTo: pick(auth.apikey, 'in') === 'query' ? 'query' : 'header',
      },
    };
  }
  return base;
}
