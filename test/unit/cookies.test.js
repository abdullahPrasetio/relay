import { describe, expect, it } from 'vitest';
import {
  coerceExpiry,
  deleteCookie,
  normalizeCookie,
  pruneExpired,
  upsertCookie,
} from '../../packages/core/src/cookie-jar.js';


describe('cookie jar CRUD helpers', () => {
  it('adds a cookie with normalized defaults', () => {
    const jar = upsertCookie([], { name: 'sid', value: 'abc', domain: 'Example.COM' });
    expect(jar).toEqual([
      {
        name: 'sid',
        value: 'abc',
        domain: 'example.com',
        path: '/',
        expires: null,
        secure: false,
        httpOnly: false,
      },
    ]);
  });

  it('replaces a cookie with the same name+domain+path', () => {
    const start = [
      { name: 'sid', value: 'old', domain: 'example.com', path: '/', expires: null },
      { name: 'sid', value: 'other', domain: 'other.com', path: '/', expires: null },
    ];
    const jar = upsertCookie(start, { name: 'sid', value: 'new', domain: 'example.com', path: '/' });
    expect(jar).toHaveLength(2);
    expect(jar[0]).toMatchObject({ name: 'sid', value: 'new', domain: 'example.com' });
    expect(jar[1].value).toBe('other');
  });

  it('adds a distinct cookie when domain or path differs', () => {
    const start = [{ name: 'sid', value: 'a', domain: 'example.com', path: '/', expires: null }];
    const withPath = upsertCookie(start, {
      name: 'sid',
      value: 'b',
      domain: 'example.com',
      path: '/api',
    });
    const withDomain = upsertCookie(withPath, {
      name: 'sid',
      value: 'c',
      domain: 'api.example.com',
      path: '/',
    });
    expect(withDomain).toHaveLength(3);
  });

  it('rejects an empty or whitespace-only name', () => {
    expect(() => normalizeCookie({ name: '', domain: 'example.com' })).toThrow(/name is required/i);
    expect(() => upsertCookie([], { name: '   ', domain: 'example.com' })).toThrow(
      /name is required/i
    );
  });

  it('coerces ISO strings, epoch numbers and numeric strings; invalid -> null', () => {
    expect(coerceExpiry('2030-01-01T00:00:00.000Z')).toBe(Date.parse('2030-01-01T00:00:00.000Z'));
    expect(coerceExpiry(1893456000000)).toBe(1893456000000);
    expect(coerceExpiry('1893456000000')).toBe(1893456000000);
    expect(coerceExpiry('not a date')).toBeNull();
    expect(coerceExpiry('')).toBeNull();
    expect(coerceExpiry(null)).toBeNull();
    expect(coerceExpiry(undefined)).toBeNull();
    expect(coerceExpiry(-5)).toBeNull();
  });

  it('stores expiry on the normalized cookie', () => {
    const jar = upsertCookie([], {
      name: 'exp',
      value: '1',
      domain: 'example.com',
      expires: '2030-01-01T00:00:00.000Z',
    });
    expect(jar[0].expires).toBe(Date.parse('2030-01-01T00:00:00.000Z'));
  });

  it('deletes only the matching name+domain+path', () => {
    const jar = [
      { name: 'a', value: '1', domain: 'example.com', path: '/' },
      { name: 'a', value: '2', domain: 'example.com', path: '/api' },
      { name: 'a', value: '3', domain: 'other.com', path: '/' },
      { name: 'b', value: '4', domain: 'example.com', path: '/' },
    ];
    const next = deleteCookie(jar, { name: 'a', domain: 'example.com', path: '/' });
    expect(next.map((c) => c.value).sort()).toEqual(['2', '3', '4']);
  });

  it('prunes only expired cookies (session cookies survive)', () => {
    const now = Date.now();
    const jar = [
      { name: 'gone', expires: now - 1000 },
      { name: 'future', expires: now + 60_000 },
      { name: 'session', expires: null },
    ];
    expect(pruneExpired(jar).map((c) => c.name)).toEqual(['future', 'session']);
  });
});
