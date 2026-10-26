import { describe, expect, it } from 'vitest';
import {
  extractPathVars,
  mergeVars,
  resolveRequest,
  resolveVars,
  varsToMap,
} from '../../src/lib/variables.js';
import { newAuth, newRequest, normalizeRequest } from '../../src/lib/factory.js';

const vars = { host: 'api.example.com', token: 'abc', region: 'eu-west-1' };

describe('resolveVars', () => {
  it('replaces known tokens and leaves unknown ones intact', () => {
    expect(resolveVars('https://{{host}}/v1/{{missing}}', vars)).toBe(
      'https://api.example.com/v1/{{missing}}'
    );
    expect(resolveVars(undefined, vars)).toBeUndefined();
  });
});

describe('variable scopes', () => {
  it('merges globals < collection < environment', () => {
    const merged = mergeVars(
      { variables: [{ key: 'a', value: 'collection' }] },
      { variables: [{ key: 'a', value: 'env' }] },
      [{ key: 'a', value: 'global' }, { key: 'b', value: 'global-b' }]
    );
    expect(merged).toEqual({ a: 'env', b: 'global-b' });
  });

  it('skips disabled rows and empty keys', () => {
    expect(
      varsToMap([
        { key: 'on', value: '1' },
        { key: 'off', value: '2', enabled: false },
        { key: '', value: '3' },
        null,
      ])
    ).toEqual({ on: '1' });
  });
});

describe('extractPathVars', () => {
  it('finds :segments but not the scheme separator', () => {
    expect(extractPathVars('https://api.test/users/:id/posts/:postId')).toEqual([
      'id',
      'postId',
    ]);
    expect(extractPathVars('https://api.test/users')).toEqual([]);
  });
});

describe('resolveRequest', () => {
  it('substitutes path vars then tokens across the request', () => {
    const req = normalizeRequest({
      method: 'POST',
      url: 'https://{{host}}/users/:id',
      pathVars: [{ key: 'id', value: 'a b' }],
      params: [{ key: 'q', value: '{{token}}', enabled: true }],
      headers: [{ key: 'X-Token', value: '{{token}}', enabled: true }],
      body: { mode: 'json', raw: '{"t":"{{token}}"}' },
    });

    const out = resolveRequest(req, vars);
    expect(out.url).toBe('https://api.example.com/users/a%20b');
    expect(out.params[0].value).toBe('abc');
    expect(out.headers[0].value).toBe('abc');
    expect(out.body.raw).toBe('{"t":"abc"}');
  });

  it('resolves every auth type, including nested and array fields', () => {
    const auth = {
      ...newAuth(),
      type: 'awsv4',
      awsv4: {
        accessKey: '{{token}}',
        secretKey: 's',
        region: '{{region}}',
        service: 's3',
        sessionToken: '',
        addTo: 'header',
      },
      jwt: {
        ...newAuth().jwt,
        payload: '{"sub":"{{token}}"}',
      },
      oauth1: { ...newAuth().oauth1, consumerKey: '{{token}}' },
      digest: { ...newAuth().digest, username: '{{token}}' },
      ntlm: { ...newAuth().ntlm, domain: '{{region}}' },
      oauth2: { ...newAuth().oauth2, scope: 'read {{token}}', extraParams: [{ key: 'aud', value: '{{token}}', enabled: true }] },
    };

    const out = resolveRequest({ ...newRequest(), auth }, vars).auth;

    expect(out.awsv4.accessKey).toBe('abc');
    expect(out.awsv4.region).toBe('eu-west-1');
    expect(out.jwt.payload).toBe('{"sub":"abc"}');
    expect(out.oauth1.consumerKey).toBe('abc');
    expect(out.digest.username).toBe('abc');
    expect(out.ntlm.domain).toBe('eu-west-1');
    expect(out.oauth2.scope).toBe('read abc');
    expect(out.oauth2.extraParams[0].value).toBe('abc');
  });

  it('keeps apikey.addTo defaulting for legacy data', () => {
    const out = resolveRequest(
      { ...newRequest(), auth: { type: 'apikey', apikey: { key: 'k', value: '{{token}}' } } },
      vars
    ).auth;
    expect(out.apikey.addTo).toBe('header');
    expect(out.apikey.value).toBe('abc');
  });
});
