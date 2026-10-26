import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fromPostmanCollection,
  fromPostmanGlobals,
  fromWorkspaceBackup,
  toPostmanCollection,
  toPostmanGlobals,
  toWorkspaceBackup,
} from '../../src/lib/postmanFormat.js';
import { newRequest } from '../../src/lib/factory.js';

const fixture = (p) =>
  JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'fixtures', p), 'utf8'));

// Generated ids differ between two imports; everything else must match.
function stripIds(value) {
  if (Array.isArray(value)) return value.map(stripIds);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key === 'id') continue;
    out[key] = stripIds(inner);
  }
  return out;
}

function roundTrip(json) {
  const first = fromPostmanCollection(json);
  const exported = toPostmanCollection(first);
  const second = fromPostmanCollection(exported);
  return { first, exported, second };
}

function requestUrl(request) {
  const collection = {
    id: 'col_url_test',
    name: 'URL Test',
    variables: [],
    items: [{ ...newRequest(), ...request }],
  };
  return toPostmanCollection(collection).item[0].request.url;
}

describe('postman collection round-trip', () => {
  it('round-trips request-level scripts, examples, path vars, file fields, and description', () => {
    const { first, second } = roundTrip(fixture('postman/collection-with-events.json'));

    expect(stripIds(second)).toEqual(stripIds(first));

    const request = first.items[0];
    expect(request.preRequest).toContain("pm.environment.set('userId', '42')");
    expect(request.tests).toContain('status is 201');
    expect(request.description).toBe('Creates a user.');

    expect(request.pathVars).toEqual([{ key: 'id', value: '42' }]);
    expect(request.url).toBe('https://api.example.com/users/:id');

    const [text, file] = request.body.form;
    expect(text).toMatchObject({ key: 'name', value: 'Ada', type: 'text' });
    expect(file).toMatchObject({ key: 'avatar', type: 'file', filePath: '', fileName: '' });

    expect(request.examples).toHaveLength(1);
    const example = request.examples[0];
    expect(example.name).toBe('Created');
    expect(example.request).toMatchObject({
      method: 'POST',
      url: 'https://api.example.com/users/42',
    });
    expect(example.request.headers).toEqual([
      { key: 'Accept', value: 'application/json', enabled: true },
    ]);
    expect(example.response).toMatchObject({
      status: 201,
      statusText: 'Created',
      contentType: 'application/json',
    });
    expect(example.response.body).toContain('"name": "Ada"');
  });

  it('round-trips folder scripts/auth/description, rich examples, and collection metadata', () => {
    const { first, exported, second } = roundTrip(fixture('postman/collection-full.json'));

    expect(stripIds(second)).toEqual(stripIds(first));

    // Collection level.
    expect(first.description).toBe('Collection with folders, scripts, auth, examples, and files.');
    expect(first.preRequest).toContain('pm.collectionVariables.set');
    expect(first.tests).toContain('collection level');
    expect(first.auth.type).toBe('bearer');
    expect(first.variables).toEqual([
      { key: 'baseUrl', value: 'https://api.example.com', enabled: true },
      { key: 'disabledVar', value: 'nope', enabled: false },
    ]);

    // Folder level.
    const folder = first.items[0];
    expect(folder.type).toBe('folder');
    expect(folder.description).toBe('Folder about users.');
    expect(folder.preRequest).toContain("pm.variables.set('folderRan', true)");
    expect(folder.tests).toBe("console.log('folder test');");
    expect(folder.auth).toMatchObject({
      type: 'basic',
      basic: { username: 'folder-user', password: 'folder-pass' },
    });

    // Exported folder keeps its scripts and auth.
    const exportedFolder = exported.item[0];
    expect(exportedFolder.description).toBe('Folder about users.');
    expect(exportedFolder.event).toHaveLength(2);
    expect(exportedFolder.auth.type).toBe('basic');

    // Request level.
    const get = folder.items[0];
    expect(get.description).toBe('Fetches one user.');
    expect(get.preRequest).toContain("pm.variables.set('id', '42')");
    expect(get.pathVars).toEqual([{ key: 'id', value: '42' }]);
    expect(get.url).toBe('https://api.example.com/users/:id');
    expect(get.examples).toHaveLength(2);
    expect(get.examples[0].request.url).toBe('https://api.example.com/users/42');
    expect(get.examples[1].request.method).toBe('POST');
    expect(get.examples[1].request.body).toMatchObject({
      mode: 'json',
      raw: '{"name":"Ada"}',
    });
    expect(get.examples[1].response.status).toBe(201);

    // File field with a path keeps its filename and content type.
    const upload = folder.items[1];
    const form = upload.body.form;
    expect(form[0]).toMatchObject({ key: 'name', type: 'text', value: 'Ada' });
    expect(form[1]).toEqual({
      key: 'avatar',
      type: 'file',
      filePath: '/tmp/avatar.png',
      fileName: 'avatar.png',
      contentType: 'image/png',
      enabled: true,
    });
    expect(form[1]).toEqual(second.items[0].items[1].body.form[1]);
  });
});

describe('postman auth types', () => {
  const loadAuthFixture = () => fromPostmanCollection(fixture('postman/collection-auth-types.json'));

  function requestByName(collection, name) {
    return collection.items[0].items.find((request) => request.name === name);
  }

  it('round-trips collection awsv4 auth and folder oauth1 auth', () => {
    const first = loadAuthFixture();
    const second = fromPostmanCollection(toPostmanCollection(first));

    expect(first.auth).toMatchObject({
      type: 'awsv4',
      awsv4: {
        accessKey: 'AKIACOLLECTION',
        secretKey: 'collection-secret',
        region: 'eu-west-1',
        service: 'execute-api',
        sessionToken: 'collection-session',
        addTo: 'query',
      },
    });
    expect(second.auth).toEqual(first.auth);

    const folder = first.items[0];
    expect(folder.auth).toMatchObject({
      type: 'oauth1',
      oauth1: {
        consumerKey: 'folder-consumer',
        consumerSecret: 'folder-consumer-secret',
        token: 'folder-token',
        tokenSecret: 'folder-token-secret',
        signatureMethod: 'HMAC-SHA256',
        realm: 'relay-realm',
        addTo: 'query',
        version: '1.0',
      },
    });
    expect(second.items[0].auth).toEqual(folder.auth);
  });

  const AUTH_REQUESTS = [
    [
      'Digest',
      'digest',
      { username: 'digest-user', password: 'digest-pass', algorithm: 'SHA-256' },
    ],
    [
      'NTLM',
      'ntlm',
      {
        username: 'ntlm-user',
        password: 'ntlm-pass',
        domain: 'RELAY',
        workstation: 'WS01',
      },
    ],
    [
      'JWT',
      'jwt',
      {
        algorithm: 'RS256',
        secret: '',
        privateKey: 'fixture-private-key',
        payload: '{"sub":"fixture","iat":1700000000}',
        kid: 'key-1',
        headerPrefix: 'Bearer',
      },
    ],
    [
      'OAuth2',
      'oauth2',
      {
        accessToken: 'oauth2-access-token',
        tokenType: 'Bearer',
        authUrl: 'https://auth.example.com/authorize',
        accessTokenUrl: 'https://auth.example.com/token',
        scope: 'read write',
        audience: 'https://api.example.com',
        clientId: 'oauth2-client',
        clientSecret: 'oauth2-secret',
        grantType: 'refresh_token',
        refreshToken: 'oauth2-refresh',
        headerPrefix: 'Bearer',
      },
    ],
    ['Basic', 'basic', { username: 'basic-user', password: 'basic-pass' }],
    ['API Key', 'apikey', { key: 'X-Api-Key', value: 'apikey-value', addTo: 'query' }],
    ['Bearer', 'bearer', { token: 'bearer-token' }],
  ];

  it.each(AUTH_REQUESTS)('round-trips request-level %s auth', (name, type, expected) => {
    const first = loadAuthFixture();
    const second = fromPostmanCollection(toPostmanCollection(first));

    const request = requestByName(first, name);
    expect(request.auth.type).toBe(type);
    expect(request.auth[type]).toMatchObject(expected);
    expect(requestByName(second, name).auth).toEqual(request.auth);
  });

  it('round-trips the whole auth fixture without drift', () => {
    const { first, second } = roundTrip(fixture('postman/collection-auth-types.json'));
    expect(stripIds(second)).toEqual(stripIds(first));
  });

  it('imports an unknown Postman auth type as inherit without throwing', () => {
    const collection = fromPostmanCollection({
      info: { name: 'Unknown Auth' },
      item: [
        {
          name: 'Hawk',
          request: {
            method: 'GET',
            url: 'https://x.test/hawk',
            auth: { type: 'hawk', hawk: [{ key: 'authId', value: 'x' }] },
          },
        },
        { name: 'Absent', request: { method: 'GET', url: 'https://x.test/absent' } },
      ],
    });

    expect(collection.items[0].auth.type).toBe('inherit');
    expect(collection.items[1].auth.type).toBe('inherit');
    expect(toPostmanCollection(collection).item[0].request.auth).toBeUndefined();
  });
});

describe('postman URL and query joining', () => {
  it('appends params to an existing query without a second ?', () => {
    const url = requestUrl({
      url: 'https://x.test/a?a=1',
      params: [{ key: 'b', value: '2', enabled: true }],
    });
    expect(url.raw).toBe('https://x.test/a?a=1&b=2');
    expect(url.raw.split('?')).toHaveLength(2);
    expect(url.query).toEqual([{ key: 'b', value: '2', disabled: false }]);
  });

  it('leaves a query-bearing URL unchanged when there are no params', () => {
    const url = requestUrl({ url: 'https://x.test/a?a=1', params: [] });
    expect(url.raw).toBe('https://x.test/a?a=1');
    expect(url.query).toEqual([]);
  });

  it('dedupes a param already present in the raw URL by key and value', () => {
    const url = requestUrl({
      url: 'https://x.test/a?a=1',
      params: [{ key: 'a', value: '1', enabled: true }],
    });
    expect(url.raw).toBe('https://x.test/a?a=1');
    expect(url.raw).not.toContain('a=1&a=1');
  });

  it('imports raw query pairs without duplicating what query[] already lists', () => {
    const collection = fromPostmanCollection({
      info: { name: 'Query' },
      item: [
        {
          name: 'R',
          request: {
            method: 'GET',
            url: {
              raw: 'https://x.test/a?a=1&b=2',
              query: [
                { key: 'a', value: '1' },
                { key: 'c', value: '3' },
              ],
            },
          },
        },
      ],
    });
    const request = collection.items[0];
    expect(request.url).toBe('https://x.test/a');
    expect(request.params).toEqual([
      { key: 'a', value: '1', enabled: true },
      { key: 'c', value: '3', enabled: true },
      { key: 'b', value: '2', enabled: true },
    ]);
  });

  it('keeps :segments in the URL and exports them as url.variable[]', () => {
    const url = requestUrl({
      url: 'https://x.test/users/:id',
      params: [],
      pathVars: [{ key: 'id', value: '42' }],
    });
    expect(url.raw).toBe('https://x.test/users/:id');
    expect(url.variable).toEqual([{ key: 'id', value: '42', disabled: false }]);
  });
});

describe('globals and workspace backup', () => {
  it('round-trips globals through the Postman globals shape', () => {
    const globals = [
      { key: 'g1', value: 'v1', enabled: true },
      { key: 'g2', value: 'v2', enabled: false },
    ];
    const exported = toPostmanGlobals(globals);
    expect(exported.name).toBe('Globals');
    expect(exported.values).toEqual([
      { key: 'g1', value: 'v1', type: 'default', enabled: true },
      { key: 'g2', value: 'v2', type: 'default', enabled: false },
    ]);
    expect(fromPostmanGlobals(JSON.parse(JSON.stringify(exported)))).toEqual(globals);
  });

  it('wraps collections, environments, and globals in a versioned backup', () => {
    const workspace = {
      name: 'Team',
      collections: [fromPostmanCollection(fixture('postman/collection-full.json'))],
      environments: [
        { id: 'env_1', name: 'Dev', variables: [{ key: 'host', value: 'http://x', enabled: true }] },
      ],
      globals: [{ key: 'g', value: 'v', enabled: true }],
    };
    const backup = toWorkspaceBackup(workspace);
    expect(backup._relayBackup).toEqual({ format: 'relay-workspace', version: 1 });
    expect(backup.collections[0].info.name).toBe('Full Fidelity');

    const restored = fromWorkspaceBackup(JSON.parse(JSON.stringify(backup)));
    expect(restored.name).toBe('Team');
    expect(restored.collections).toHaveLength(1);
    expect(restored.collections[0].name).toBe('Full Fidelity');
    expect(restored.environments).toEqual(workspace.environments);
    expect(restored.globals).toEqual(workspace.globals);
  });

  it('rejects JSON that is not a relay backup', () => {
    expect(fromWorkspaceBackup(null)).toBeNull();
    expect(fromWorkspaceBackup({ collections: [] })).toBeNull();
  });
});
