import { describe, expect, it } from 'vitest';
import {
  buildScopeVars,
  extractPathVars,
  mergeVars,
  resolveRequest,
  resolveVars,
  varsToMap,
} from '../../packages/core/src/variables.js';
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

describe('buildScopeVars precedence', () => {
  it('collection beats globals', () => {
    expect(buildScopeVars({ globals: { a: 'g' }, collection: { a: 'c' } })).toEqual({ a: 'c' });
  });

  it('environment beats collection', () => {
    expect(buildScopeVars({ collection: { a: 'c' }, environment: { a: 'e' } })).toEqual({ a: 'e' });
  });

  it('iteration data beats environment', () => {
    expect(buildScopeVars({ environment: { a: 'e' }, iterationData: { a: 'd' } })).toEqual({
      a: 'd',
    });
  });

  it('local beats iteration data', () => {
    expect(buildScopeVars({ iterationData: { a: 'd' }, local: { a: 'l' } })).toEqual({
      a: 'l',
    });
  });

  it('applies the full local > data > env > collection > globals order', () => {
    const merged = buildScopeVars({
      local: { a: 'local', l: 'local-only' },
      iterationData: { a: 'data', d: 'data-only' },
      environment: { a: 'env', e: 'env-only' },
      collection: { a: 'collection', c: 'collection-only' },
      globals: { a: 'global', g: 'global-only' },
    });
    expect(merged).toEqual({
      a: 'local',
      g: 'global-only',
      c: 'collection-only',
      e: 'env-only',
      d: 'data-only',
      l: 'local-only',
    });
  });

  it('tolerates missing scopes', () => {
    expect(buildScopeVars({ environment: { a: 'e' } })).toEqual({ a: 'e' });
    expect(buildScopeVars()).toEqual({});
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

describe('dynamic variables', () => {
  const empty = {};

  it('expands $guid to a UUID v4', () => {
    const out = resolveVars('id={{$guid}}', empty);
    expect(out).toMatch(
      /^id=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('expands $timestamp to epoch seconds', () => {
    const before = Math.floor(Date.now() / 1000);
    const out = resolveVars('{{$timestamp}}', empty);
    const value = Number(out);
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 1);
  });

  it('expands $isoTimestamp to a parseable ISO date', () => {
    const out = resolveVars('{{$isoTimestamp}}', empty);
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(out))).toBe(false);
  });

  it('expands $randomInt inside 0..1000', () => {
    for (let i = 0; i < 25; i += 1) {
      const value = Number(resolveVars('{{$randomInt}}', empty));
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1000);
    }
  });

  it('expands $randomFirstName to a non-empty name', () => {
    const out = resolveVars('{{$randomFirstName}}', empty);
    expect(out.length).toBeGreaterThan(0);
    expect(out).toMatch(/^[A-Za-z]+$/);
  });

  it('expands $randomEmail to an email-shaped address', () => {
    const out = resolveVars('{{$randomEmail}}', empty);
    expect(out).toMatch(/^[a-z]+\.[a-z]+@example\.com$/);
  });

  it('handles whitespace inside dynamic tokens', () => {
    expect(resolveVars('{{ $randomInt }}', empty)).toMatch(/^\d+$/);
  });

  it('prefers dynamic expansion over a scope entry with the same $ name', () => {
    const out = resolveVars('{{$guid}}', { $guid: 'from-scope' });
    expect(out).not.toBe('from-scope');
    expect(out).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('still resolves normal tokens alongside dynamic ones', () => {
    const out = resolveVars('{{host}}/{{$randomInt}}', vars);
    expect(out).toMatch(/^api\.example\.com\/\d+$/);
  });
});

describe('onUnresolved reporting', () => {
  it('reports unknown dynamic tokens and leaves them intact', () => {
    const calls = [];
    const out = resolveVars('{{$nope}}', {}, { onUnresolved: (name, info) => calls.push([name, info]) });
    expect(out).toBe('{{$nope}}');
    expect(calls).toEqual([['$nope', { dynamic: true }]]);
  });

  it('reports unknown normal tokens and leaves them intact', () => {
    const calls = [];
    const out = resolveVars('{{missing}}', { host: 'x' }, {
      onUnresolved: (name, info) => calls.push([name, info]),
    });
    expect(out).toBe('{{missing}}');
    expect(calls).toEqual([['missing', { dynamic: false }]]);
  });

  it('does not report known or dynamic tokens', () => {
    const calls = [];
    resolveVars('{{host}} {{$guid}}', vars, { onUnresolved: (name) => calls.push(name) });
    expect(calls).toEqual([]);
  });

  it('works without the third argument', () => {
    expect(resolveVars('{{missing}}', {})).toBe('{{missing}}');
  });
});

describe('resolveRequest unresolved reporting', () => {
  it('forwards onUnresolved and leaves the trickiest tokens intact', () => {
    const calls = [];
    const req = normalizeRequest({
      url: 'https://{{host}}/{{missing}}',
      params: [{ key: 'p', value: '{{alsoMissing}}', enabled: true }],
      headers: [{ key: 'h', value: '{{host}}', enabled: true }],
      body: { mode: 'json', raw: '{"v":"{{$nope}}"}' },
    });

    const out = resolveRequest(req, vars, {
      onUnresolved: (name, info) => calls.push([name, info.dynamic]),
    });

    expect(out.url).toBe('https://api.example.com/{{missing}}');
    expect(out.body.raw).toBe('{"v":"{{$nope}}"}');
    expect(calls.sort()).toEqual([
      ['$nope', true],
      ['alsoMissing', false],
      ['missing', false],
    ]);
  });
});
