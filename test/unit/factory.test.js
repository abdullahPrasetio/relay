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
