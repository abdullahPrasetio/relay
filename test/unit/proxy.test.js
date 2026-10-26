import { afterEach, describe, expect, it } from 'vitest';
import {
  buildProxyUrl,
  resolveProxy,
  shouldBypass,
  splitBypass,
} from '../../electron/proxy.js';

const ENV_KEYS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'];
const saved = {};

function clearProxyEnv() {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
    delete saved[k];
  }
});

const profile = {
  id: 'px_corp',
  name: 'Corporate',
  protocol: 'http',
  host: 'proxy.corp',
  port: 8080,
  username: '',
  password: '',
  bypass: [],
};

const network = (overrides = {}) => ({
  proxyMode: 'none',
  activeProxyId: null,
  proxies: [profile],
  ...overrides,
});

describe('shouldBypass', () => {
  it('matches exact hosts', () => {
    expect(shouldBypass('localhost', ['localhost'])).toBe(true);
    expect(shouldBypass('localhost', ['example.com'])).toBe(false);
    expect(shouldBypass('LOCALHOST', ['LocalHost'])).toBe(true);
  });

  it('matches .suffix and *.suffix', () => {
    expect(shouldBypass('api.corp', ['.corp'])).toBe(true);
    expect(shouldBypass('corp', ['.corp'])).toBe(true);
    expect(shouldBypass('api.corp', ['*.corp'])).toBe(true);
    expect(shouldBypass('deep.api.corp', ['*.corp'])).toBe(true);
    expect(shouldBypass('notcorp', ['*.corp'])).toBe(false);
  });

  it('matches everything with *', () => {
    expect(shouldBypass('anything.test', ['*'])).toBe(true);
  });

  it('ignores blank entries', () => {
    expect(shouldBypass('a.test', ['', '  '])).toBe(false);
    expect(shouldBypass('a.test', [])).toBe(false);
  });
});

describe('splitBypass', () => {
  it('trims, lowercases and drops empties', () => {
    expect(splitBypass(' A.test , ,*.Corp ')).toEqual(['a.test', '*.corp']);
    expect(splitBypass('')).toEqual([]);
  });
});

describe('buildProxyUrl', () => {
  it('embeds credentials percent-encoded', () => {
    const url = buildProxyUrl({
      ...profile,
      username: 'user@corp',
      password: 'p@ss word',
    });
    expect(url).toBe('http://user%40corp:p%40ss%20word@proxy.corp:8080');
  });

  it('omits auth when there is no username', () => {
    expect(buildProxyUrl(profile)).toBe('http://proxy.corp:8080');
    expect(buildProxyUrl({ ...profile, host: '' })).toBe('');
  });
});

describe('resolveProxy', () => {
  afterEach(clearProxyEnv);

  it('uses the active profile in manual mode', () => {
    const out = resolveProxy({
      targetUrl: 'https://api.test/',
      network: network({ proxyMode: 'manual', activeProxyId: 'px_corp' }),
      requestSettings: {},
    });
    expect(out.url).toBe('http://proxy.corp:8080');
    expect(out.bypass).toEqual([]);
  });

  it('lets an explicit request profile override the app mode', () => {
    const other = { ...profile, id: 'px_other', host: 'other.proxy', port: 3128 };
    const out = resolveProxy({
      targetUrl: 'https://api.test/',
      network: network({ proxyMode: 'none', proxies: [profile, other] }),
      requestSettings: { proxyId: 'px_other' },
    });
    expect(out.url).toBe('http://other.proxy:3128');
  });

  it('disables proxying when the request asks for none', () => {
    const out = resolveProxy({
      targetUrl: 'https://api.test/',
      network: network({ proxyMode: 'manual', activeProxyId: 'px_corp' }),
      requestSettings: { proxyId: 'none' },
    });
    expect(out).toBeNull();
  });

  it('falls back to direct when the profile is missing or has no host', () => {
    expect(
      resolveProxy({
        targetUrl: 'https://api.test/',
        network: network({ proxyMode: 'manual', activeProxyId: 'px_gone' }),
        requestSettings: {},
      })
    ).toBeNull();

    expect(
      resolveProxy({
        targetUrl: 'https://api.test/',
        network: network({ proxyMode: 'manual', activeProxyId: 'px_corp' }),
        requestSettings: { proxyId: 'px_deleted' },
      })
    ).toBeNull();

    expect(
      resolveProxy({
        targetUrl: 'https://api.test/',
        network: {
          proxyMode: 'manual',
          activeProxyId: 'px_empty',
          proxies: [{ ...profile, id: 'px_empty', host: '' }],
        },
        requestSettings: {},
      })
    ).toBeNull();
  });

  describe('environment mode', () => {
    it('prefers HTTPS_PROXY for https targets', () => {
      clearProxyEnv();
      process.env.HTTPS_PROXY = 'http://secure.proxy:8080';
      process.env.HTTP_PROXY = 'http://plain.proxy:8080';
      const out = resolveProxy({
        targetUrl: 'https://api.test/',
        network: network({ proxyMode: 'environment' }),
        requestSettings: {},
      });
      expect(out.url).toBe('http://secure.proxy:8080');
    });

    it('uses HTTP_PROXY for http targets', () => {
      clearProxyEnv();
      process.env.HTTPS_PROXY = 'http://secure.proxy:8080';
      process.env.HTTP_PROXY = 'http://plain.proxy:8080';
      const out = resolveProxy({
        targetUrl: 'http://api.test/',
        network: network({ proxyMode: 'environment' }),
        requestSettings: {},
      });
      expect(out.url).toBe('http://plain.proxy:8080');
    });

    it('falls back to HTTP_PROXY for https targets and reads NO_PROXY', () => {
      clearProxyEnv();
      process.env.HTTP_PROXY = 'proxy.corp:8080'; // scheme-less is common
      process.env.NO_PROXY = 'localhost, .internal';
      const out = resolveProxy({
        targetUrl: 'https://api.test/',
        network: network({ proxyMode: 'environment' }),
        requestSettings: {},
      });
      expect(out.url).toBe('http://proxy.corp:8080');
      expect(out.bypass).toEqual(['localhost', '.internal']);
    });

    it('is direct when no env proxy is set', () => {
      clearProxyEnv();
      const out = resolveProxy({
        targetUrl: 'https://api.test/',
        network: network({ proxyMode: 'environment' }),
        requestSettings: {},
      });
      expect(out).toBeNull();
    });
  });
});
