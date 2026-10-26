import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NETWORK_SETTINGS,
  normalizeNetworkSettings,
  sanitizeNetworkSettings,
} from '../../shared/networkSettings.js';

describe('normalizeNetworkSettings', () => {
  it('clamps out-of-range numbers and falls back for garbage', () => {
    const s = normalizeNetworkSettings({
      timeoutMs: 0,
      maxRedirects: 999,
      maxResponseBytes: 5,
      proxies: [{ id: 'px_a', name: 'A', protocol: 'http', host: 'h', port: 999999 }],
    });
    expect(s.timeoutMs).toBe(1); // clamped up to the minimum
    expect(s.maxRedirects).toBe(50);
    expect(s.maxResponseBytes).toBe(1024);
    expect(s.proxies[0].port).toBe(65535);

    const garbage = normalizeNetworkSettings({
      timeoutMs: 'nope',
      maxRedirects: null,
      maxResponseBytes: 'x',
    });
    expect(garbage.timeoutMs).toBe(DEFAULT_NETWORK_SETTINGS.timeoutMs);
    expect(garbage.maxRedirects).toBe(DEFAULT_NETWORK_SETTINGS.maxRedirects);
    expect(garbage.maxResponseBytes).toBe(DEFAULT_NETWORK_SETTINGS.maxResponseBytes);
  });

  it('clamps to the maximum as well', () => {
    const s = normalizeNetworkSettings({ timeoutMs: 99999999 });
    expect(s.timeoutMs).toBe(3600000);
    expect(normalizeNetworkSettings({ proxies: [{ host: 'h', port: 0 }] }).proxies[0].port).toBe(1);
  });

  it('rejects unknown proxy modes and protocols', () => {
    const s = normalizeNetworkSettings({
      proxyMode: 'system',
      proxies: [{ id: 'px_a', protocol: 'ftp', host: 'h', port: 80 }],
    });
    expect(s.proxyMode).toBe('none');
    expect(s.proxies[0].protocol).toBe('http');
  });

  it('drops activeProxyId when no profile matches', () => {
    const s = normalizeNetworkSettings({ activeProxyId: 'px_missing', proxies: [] });
    expect(s.activeProxyId).toBeNull();
  });

  it('keeps ciphertext but drops plaintext secrets', () => {
    const s = normalizeNetworkSettings({
      proxies: [
        {
          id: 'px_a',
          host: 'h',
          port: 80,
          password: 'hunter2',
          passwordEnc: 'cipher==',
        },
      ],
      clientCertPassphrase: 'pass',
      clientCertPassphraseEnc: 'passcipher==',
    });
    expect(s.proxies[0].passwordEnc).toBe('cipher==');
    expect(s.proxies[0].password).toBeUndefined();
    expect(s.clientCertPassphrase).toBeUndefined();
    expect(s.clientCertPassphraseEnc).toBe('passcipher==');
  });

  it('normalizes bypass lists', () => {
    const s = normalizeNetworkSettings({
      proxies: [{ id: 'px_a', host: 'h', port: 80, bypass: [' localhost ', '', '*.corp'] }],
      bypass: 'a, b',
    });
    expect(s.proxies[0].bypass).toEqual(['localhost', '*.corp']);
    expect(s.bypass).toBeUndefined();
  });

  it('defaults the SNI override to empty and trims it when set', () => {
    expect(normalizeNetworkSettings({}).servername).toBe('');
    expect(normalizeNetworkSettings({ servername: '  api.corp  ' }).servername).toBe('api.corp');
    expect(sanitizeNetworkSettings({ servername: 'api.corp' }).servername).toBe('api.corp');
  });
});

describe('sanitizeNetworkSettings', () => {
  it('never exposes ciphertext and reports presence flags', () => {
    const view = sanitizeNetworkSettings({
      proxies: [
        { id: 'px_a', name: 'A', host: 'h', port: 80, passwordEnc: 'cipher==' },
        { id: 'px_b', name: 'B', host: 'h', port: 81 },
      ],
      clientCertPassphraseEnc: 'passcipher==',
    });

    expect(view.passwordEnc).toBeUndefined();
    expect(view.clientCertPassphraseEnc).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain('cipher');
    expect(view.proxies[0].hasPassword).toBe(true);
    expect(view.proxies[1].hasPassword).toBe(false);
    expect(view.hasClientCertPassphrase).toBe(true);
  });

  it('is stable: sanitizing a sanitized view preserves presence flags', () => {
    const once = sanitizeNetworkSettings({
      proxies: [{ id: 'px_a', name: 'A', host: 'h', port: 80, passwordEnc: 'cipher==' }],
    });
    const twice = sanitizeNetworkSettings(once);
    expect(twice.proxies[0].hasPassword).toBe(true);
  });
});
