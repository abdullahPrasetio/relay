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
    type: 'inherit', // inherit | none | bearer | basic | apikey | oauth1 | oauth2 | digest | ntlm | awsv4 | jwt
    bearer: { token: '' },
    basic: { username: '', password: '' },
    apikey: { key: '', value: '', addTo: 'header' }, // header | query
    oauth1: {
      consumerKey: '',
      consumerSecret: '',
      token: '',
      tokenSecret: '',
      signatureMethod: 'HMAC-SHA1', // HMAC-SHA1 | HMAC-SHA256 | PLAINTEXT
      realm: '',
      addTo: 'header', // header | query
      version: '1.0',
    },
    oauth2: {
      grantType: 'client_credentials', // authorization_code | client_credentials | password | refresh_token
      authUrl: '', // authorization endpoint (authorization_code)
      accessTokenUrl: '',
      clientId: '',
      clientSecret: '',
      username: '', // for password grant
      password: '',
      scope: '',
      audience: '',
      extraParams: [], // [{ key, value, enabled }]
      clientAuth: 'body', // body | basic (how to send client creds)
      redirectUri: '', // loopback URI assigned during the authorize flow
      refreshToken: '',
      accessToken: '', // the fetched/stored token
      tokenType: 'Bearer',
      expiresAt: null, // epoch ms, informational for the UI
      codeVerifier: '', // retained only for the authorize call
      headerPrefix: 'Bearer',
    },
    digest: { username: '', password: '', algorithm: 'MD5' },
    ntlm: { username: '', password: '', domain: '', workstation: '' },
    awsv4: {
      accessKey: '',
      secretKey: '',
      sessionToken: '',
      region: '',
      service: '',
      addTo: 'header', // header | query
    },
    jwt: {
      algorithm: 'HS256', // HS256 | HS384 | HS512 | RS256 | RS384 | RS512
      secret: '',
      privateKey: '',
      payload: '{\n  "sub": ""\n}',
      kid: '',
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
      oauth1: { ...newAuth().oauth1, ...(req.auth?.oauth1 || {}) },
      oauth2: {
        ...newAuth().oauth2,
        ...(req.auth?.oauth2 || {}),
        extraParams: Array.isArray(req.auth?.oauth2?.extraParams)
          ? req.auth.oauth2.extraParams
          : newAuth().oauth2.extraParams,
      },
      digest: { ...newAuth().digest, ...(req.auth?.digest || {}) },
      ntlm: { ...newAuth().ntlm, ...(req.auth?.ntlm || {}) },
      awsv4: { ...newAuth().awsv4, ...(req.auth?.awsv4 || {}) },
      jwt: { ...newAuth().jwt, ...(req.auth?.jwt || {}) },
    },
    settings: { ...newRequestSettings(), ...(req.settings || {}) },
  };
}
