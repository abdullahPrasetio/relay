import { describe, expect, it } from 'vitest';
import { newRequest, normalizeRequest } from '../../src/lib/factory.js';

describe('request settings defaults', () => {
  it('gives legacy requests (no settings) the inherit-by-default shape', () => {
    const req = normalizeRequest({ id: 'req_old', url: 'https://example.com' });

    expect(req.settings).toEqual({
      timeoutMs: null,
      followRedirects: null,
      maxRedirects: null,
      verifyTls: null,
      proxyId: null,
      useCookieJar: true,
    });
  });

  it('keeps explicit per-request overrides and fills the rest', () => {
    const req = normalizeRequest({ settings: { timeoutMs: 500, useCookieJar: false } });

    expect(req.settings.timeoutMs).toBe(500);
    expect(req.settings.useCookieJar).toBe(false);
    expect(req.settings.verifyTls).toBeNull();
  });

  it('creates new requests with the cookie jar enabled', () => {
    expect(newRequest().settings.useCookieJar).toBe(true);
  });
});

describe('request documentation defaults', () => {
  it('starts with a description and empty validation sections', () => {
    const req = newRequest();
    expect(req.description).toBe('');
    expect(req.fieldValidations).toEqual({
      path: {},
      params: {},
      headers: {},
      body: {},
    });
  });

  it('normalizes Wapbolt snake_case validations and preserves descriptions', () => {
    const req = normalizeRequest({
      description: 'Creates a user.',
      field_validations: {
        headers: { 'X-Key': { rules: ['required'], description: 'API key' } },
      },
    });
    expect(req.description).toBe('Creates a user.');
    expect(req.fieldValidations.headers['X-Key']).toEqual({
      rules: ['required'],
      min: 0,
      max: 0,
      description: 'API key',
    });
    expect(req.fieldValidations.params).toEqual({});
  });
});
