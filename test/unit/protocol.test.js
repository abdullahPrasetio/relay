import { describe, expect, it } from 'vitest';
import { protocolFor, isWebSocket } from '../../src/lib/protocol.js';
import {
  protocolFor as adapterProtocolFor,
  getAdapter,
} from '../../electron/protocols/index.js';

describe('protocolFor', () => {
  it('recognises the supported schemes', () => {
    expect(protocolFor('http://example.com')).toBe('http');
    expect(protocolFor('https://example.com/a?b=1')).toBe('https');
    expect(protocolFor('ws://example.com/socket')).toBe('ws');
    expect(protocolFor('wss://example.com/socket')).toBe('wss');
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(protocolFor('  WSS://EXAMPLE.COM  ')).toBe('wss');
    expect(protocolFor('HTTPS://example.com')).toBe('https');
  });

  it('defaults scheme-less URLs to https', () => {
    expect(protocolFor('api.example.com/users')).toBe('https');
    expect(protocolFor('localhost:8080/health')).toBe('https');
    expect(protocolFor('example.com')).toBe('https');
  });

  it('returns null for invalid or unsupported input', () => {
    expect(protocolFor('')).toBeNull();
    expect(protocolFor('   ')).toBeNull();
    expect(protocolFor(null)).toBeNull();
    expect(protocolFor(undefined)).toBeNull();
    expect(protocolFor(42)).toBeNull();
    expect(protocolFor({ url: 'ws://x' })).toBeNull();
    expect(protocolFor('ftp://example.com/file')).toBeNull();
    expect(protocolFor('mailto:user@example.com')).toBeNull();
    expect(protocolFor('file:///tmp/x')).toBeNull();
  });
});

describe('isWebSocket', () => {
  it('is true only for ws and wss', () => {
    expect(isWebSocket('ws://localhost')).toBe(true);
    expect(isWebSocket('wss://localhost')).toBe(true);
    expect(isWebSocket('WSS://localhost')).toBe(true);
    expect(isWebSocket('http://localhost')).toBe(false);
    expect(isWebSocket('https://localhost')).toBe(false);
    expect(isWebSocket('localhost:3000')).toBe(false);
    expect(isWebSocket('')).toBe(false);
  });
});

describe('protocol adapter registry', () => {
  it('mirrors the protocol helper', () => {
    expect(adapterProtocolFor('wss://example.com')).toBe('wss');
    expect(adapterProtocolFor('example.com')).toBe('https');
    expect(adapterProtocolFor('ftp://example.com')).toBeNull();
  });

  it('registers HTTP schemes as request adapters', () => {
    expect(getAdapter('http')).toMatchObject({ id: 'http', kind: 'request' });
    expect(getAdapter('https')).toMatchObject({ id: 'https', kind: 'request' });
  });

  it('registers ws/wss as stream adapters backed by the socket module', () => {
    for (const scheme of ['ws', 'wss']) {
      const adapter = getAdapter(scheme);
      expect(adapter).toMatchObject({ id: scheme, kind: 'stream' });
      expect(typeof adapter.open).toBe('function');
      expect(typeof adapter.send).toBe('function');
      expect(typeof adapter.close).toBe('function');
      expect(typeof adapter.history).toBe('function');
    }
    expect(getAdapter('WS')).toBe(getAdapter('ws'));
  });

  it('returns null for unknown protocols', () => {
    expect(getAdapter('ftp')).toBeNull();
    expect(getAdapter('')).toBeNull();
    expect(getAdapter(null)).toBeNull();
    expect(getAdapter('graphql')).toBeNull();
  });
});
