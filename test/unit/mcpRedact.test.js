import { describe, expect, it } from 'vitest';
import {
  MAX_MCP_STRING,
  redactCollection,
  redactCookies,
  redactForMcp,
  redactNetworkSettings,
  redactRequest,
  redactVariableRows,
  redactWorkspace,
  secretPool,
  serializeMcpResult,
} from '../../src/lib/mcpRedact.js';

function workspace() {
  return {
    id: 'ws_1',
    name: 'Demo',
    activeEnvId: 'env_1',
    globals: [
      { key: 'GLOBAL_TOKEN', value: 'globalsecret', enabled: true, type: 'secret' },
      { key: 'PLAIN', value: 'visible', enabled: true, type: 'default' },
    ],
    environments: [
      {
        id: 'env_1',
        name: 'Dev',
        variables: [
          { key: 'API_KEY', value: 'supersecret', enabled: true, type: 'secret' },
          { key: 'HOST', value: 'https://api.test', enabled: true, type: 'default' },
        ],
      },
    ],
    collections: [
      {
        id: 'col_1',
        name: 'Orders',
        variables: [
          { key: 'COL_SECRET', value: 'colsecret', enabled: true, type: 'secret' },
        ],
        auth: { type: 'bearer', bearer: { token: 'col-token' } },
        items: [
          {
            id: 'fld_1',
            type: 'folder',
            name: 'Folder',
            variables: [
              { key: 'FOLDER_SECRET', value: 'foldersecret', enabled: true, type: 'secret' },
            ],
            items: [
              {
                id: 'req_1',
                type: 'request',
                name: 'Create order',
                description: 'uses supersecret in the description',
                method: 'POST',
                url: 'https://api.test/orders',
                auth: {
                  type: 'bearer',
                  bearer: { token: 'bearer-token' },
                  basic: { username: 'u', password: 'basic-pass' },
                  apikey: { key: 'x-api-key', value: 'api-key-value', addTo: 'header' },
                  oauth2: {
                    clientSecret: 'oauth-secret',
                    accessToken: 'access-token',
                    refreshToken: 'refresh-token',
                    password: 'oauth-pass',
                    codeVerifier: 'verifier',
                  },
                  oauth1: { consumerSecret: 'consumer-secret', tokenSecret: 'token-secret' },
                  digest: { password: 'digest-pass' },
                  ntlm: { password: 'ntlm-pass' },
                  awsv4: { secretKey: 'aws-secret', sessionToken: 'aws-session' },
                  jwt: { secret: 'jwt-secret', privateKey: 'jwt-key' },
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('secretPool', () => {
  it('collects secret values from the active env, collections, folders and globals', () => {
    const pool = secretPool(workspace());
    expect(pool).toContain('supersecret');
    expect(pool).toContain('colsecret');
    expect(pool).toContain('foldersecret');
    expect(pool).toContain('globalsecret');
    expect(pool).not.toContain('visible');
  });

  it('is null-safe and deduplicates', () => {
    expect(secretPool(null)).toEqual([]);
    const pool = secretPool({
      activeEnvId: null,
      environments: [],
      globals: [
        { key: 'A', value: 'same-secret', type: 'secret' },
        { key: 'B', value: 'same-secret', type: 'secret' },
      ],
      collections: [],
    });
    expect(pool).toEqual(['same-secret']);
  });
});

describe('redactWorkspace', () => {
  it('never exposes a secret value or its ciphertext', () => {
    const source = workspace();
    source.environments[0].variables[0].secretEnc = 'ciphertext-blob';
    const redacted = redactWorkspace(source);
    // The dispatcher always follows redaction with serialization, which masks
    // declared secrets wherever they appear in text.
    const text = JSON.stringify(serializeMcpResult(redacted, secretPool(source)));
    expect(text).not.toContain('supersecret');
    expect(text).not.toContain('colsecret');
    expect(text).not.toContain('foldersecret');
    expect(text).not.toContain('globalsecret');
    expect(text).not.toContain('ciphertext-blob');
    expect(text).not.toContain('secretEnc');

    expect(redacted.environments[0].variables[0]).toEqual({
      key: 'API_KEY',
      type: 'secret',
      enabled: true,
      hasValue: true,
    });
    expect(redacted.environments[0].variables[1]).toMatchObject({ key: 'HOST', value: 'https://api.test' });
    expect(redacted.collections[0].items[0].items[0].id).toBe('req_1');
  });
});

describe('redactRequest', () => {
  it('blanks every declared auth secret and keeps the shape', () => {
    const redacted = redactRequest(workspace().collections[0].items[0].items[0]);
    const auth = redacted.auth;
    expect(auth.bearer.token).toBe('');
    expect(auth.basic.password).toBe('');
    expect(auth.basic.username).toBe('u');
    expect(auth.apikey.value).toBe('');
    expect(auth.oauth1.consumerSecret).toBe('');
    expect(auth.oauth1.tokenSecret).toBe('');
    expect(auth.oauth2.clientSecret).toBe('');
    expect(auth.oauth2.accessToken).toBe('');
    expect(auth.oauth2.refreshToken).toBe('');
    expect(auth.oauth2.password).toBe('');
    expect(auth.oauth2.codeVerifier).toBe('');
    expect(auth.digest.password).toBe('');
    expect(auth.ntlm.password).toBe('');
    expect(auth.awsv4.secretKey).toBe('');
    expect(auth.awsv4.sessionToken).toBe('');
    expect(auth.jwt.secret).toBe('');
    expect(auth.jwt.privateKey).toBe('');
  });

  it('does not mutate the source request', () => {
    const source = workspace().collections[0].items[0].items[0];
    redactRequest(source);
    expect(source.auth.bearer.token).toBe('bearer-token');
  });
});

describe('redactCollection', () => {
  it('drops ciphertext keys and blanks collection auth', () => {
    const collection = {
      id: 'c',
      name: 'C',
      variables: [{ key: 'K', type: 'secret', value: '', secretEnc: 'abc', enabled: true }],
      auth: { type: 'bearer', bearer: { token: 't' } },
      items: [],
    };
    const redacted = redactCollection(collection);
    expect(JSON.stringify(redacted)).not.toContain('abc');
    expect(redacted.auth.bearer.token).toBe('');
    expect(redacted.variables[0]).toEqual({
      key: 'K',
      type: 'secret',
      enabled: true,
      hasValue: true,
    });
  });
});

describe('redactForMcp', () => {
  it('masks known secrets in arbitrary strings and drops ciphertext keys', () => {
    const out = redactForMcp(
      { note: 'the key is supersecret', nested: { tokenEnc: 'x', keep: 'ok' } },
      ['supersecret']
    );
    expect(out.note).toBe('the key is ••••');
    expect(out.nested.tokenEnc).toBeUndefined();
    expect(out.nested.keep).toBe('ok');
  });
});

describe('redactVariableRows', () => {
  it('reduces secret rows to metadata and keeps plain rows', () => {
    const rows = redactVariableRows([
      { key: 'S', value: 'plain', enabled: true, type: 'secret', secretEnc: 'enc' },
      { key: 'P', value: 'value', enabled: false, type: 'default' },
    ]);
    expect(rows[0]).toEqual({ key: 'S', type: 'secret', enabled: true, hasValue: true });
    expect(rows[1]).toEqual({ key: 'P', value: 'value', enabled: false, type: 'default' });
    expect(redactVariableRows(null)).toEqual([]);
  });
});

describe('redactNetworkSettings', () => {
  it('replaces proxy and TLS secrets with booleans', () => {
    const redacted = redactNetworkSettings({
      proxyMode: 'manual',
      timeoutMs: 30000,
      clientCertPassphraseEnc: 'cert-enc',
      proxies: [
        {
          id: 'p1',
          name: 'Corp',
          protocol: 'http',
          host: 'proxy.test',
          port: 8080,
          username: 'u',
          passwordEnc: 'proxy-enc',
          bypass: ['localhost'],
        },
      ],
    });
    expect(JSON.stringify(redacted)).not.toContain('proxy-enc');
    expect(JSON.stringify(redacted)).not.toContain('cert-enc');
    expect(redacted.hasClientCertPassphrase).toBe(true);
    expect(redacted.proxies[0].hasPassword).toBe(true);
    expect(redacted.proxies[0].passwordEnc).toBeUndefined();
    expect(redacted.proxies[0].host).toBe('proxy.test');
  });
});

describe('redactCookies', () => {
  it('never returns a cookie value', () => {
    const redacted = redactCookies([
      { name: 'sid', value: 'cookie-secret', domain: 'api.test', path: '/', secure: true },
    ]);
    expect(JSON.stringify(redacted)).not.toContain('cookie-secret');
    expect(redacted[0]).toMatchObject({ name: 'sid', domain: 'api.test', hasValue: true });
    expect(redactCookies(null)).toEqual([]);
  });
});

describe('serializeMcpResult', () => {
  it('masks secret text in the result', () => {
    const out = serializeMcpResult(
      { description: 'calls supersecret and globalsecret', list: ['supersecret'] },
      ['supersecret', 'globalsecret']
    );
    expect(out.description).toBe('calls •••• and ••••');
    expect(out.list[0]).toBe('••••');
  });

  it('truncates strings over the 128 KiB cap', () => {
    const big = 'a'.repeat(MAX_MCP_STRING + 10);
    const out = serializeMcpResult({ big }, []);
    expect(out.big).toHaveLength(MAX_MCP_STRING);
  });
});
