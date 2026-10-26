// Factory helpers for creating default request / collection / environment shapes.

let idCounter = 0;
export function uid(prefix = 'id') {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

export function newRequest(overrides = {}) {
  return {
    id: uid('req'),
    name: 'Untitled Request',
    method: 'GET',
    url: '',
    params: [],
    pathVars: [],
    headers: [],
    body: newBody(),
    auth: newAuth(),
    settings: newRequestSettings(),
    preRequest: '',
    tests: '',
    examples: [], // saved request/response snapshots
    ...overrides,
  };
}

// Per-request network overrides. `null` means "inherit the app setting", so
// these stay sparse and survive app-wide setting changes.
export function newRequestSettings() {
  return {
    timeoutMs: null,
    followRedirects: null,
    maxRedirects: null,
    verifyTls: null,
    proxyId: null,
    useCookieJar: true,
  };
}

export function newBody() {
  return {
    mode: 'none', // none | raw | json | form-urlencoded | form-data | graphql
    raw: '',
    form: [], // [{key,value,enabled}]
    graphql: { query: '', variables: '' }, // GraphQL query + JSON variables
  };
}

export function newAuth() {
  return {
    // 'inherit' means: use the parent collection's auth. Requests default to
    // inherit; collections themselves cannot inherit so they default to none.
    type: 'inherit', // inherit | none | bearer | basic | apikey | oauth2
    bearer: { token: '' },
    basic: { username: '', password: '' },
    apikey: { key: '', value: '', addTo: 'header' }, // header | query
    oauth2: {
      grantType: 'client_credentials', // client_credentials | password
      accessTokenUrl: '',
      clientId: '',
      clientSecret: '',
      username: '', // for password grant
      password: '',
      scope: '',
      clientAuth: 'body', // body | basic (how to send client creds)
      accessToken: '', // the fetched/stored token
      headerPrefix: 'Bearer',
    },
  };
}

export function newCollection(name = 'New Collection') {
  return {
    id: uid('col'),
    name,
    description: '',
    variables: [],
    auth: { ...newAuth(), type: 'none' }, // collections can't inherit
    preRequest: '',
    tests: '',
    items: [],
  };
}

export function newEnvironment(name = 'New Environment') {
  return {
    id: uid('env'),
    name,
    variables: [],
  };
}

export function newKeyValue() {
  return { key: '', value: '', enabled: true };
}

// Normalize a request loaded from storage/import so new fields always exist.
export function normalizeRequest(req) {
  return {
    ...newRequest(),
    ...req,
    examples: Array.isArray(req.examples) ? req.examples : [],
    pathVars: Array.isArray(req.pathVars) ? req.pathVars : [],
    body: {
      ...newBody(),
      ...(req.body || {}),
      graphql: { ...newBody().graphql, ...(req.body?.graphql || {}) },
    },
    auth: {
      ...newAuth(),
      ...(req.auth || {}),
      bearer: { ...newAuth().bearer, ...(req.auth?.bearer || {}) },
      basic: { ...newAuth().basic, ...(req.auth?.basic || {}) },
      apikey: { ...newAuth().apikey, ...(req.auth?.apikey || {}) },
      oauth2: { ...newAuth().oauth2, ...(req.auth?.oauth2 || {}) },
    },
    settings: { ...newRequestSettings(), ...(req.settings || {}) },
  };
}
