import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../../electron/store.js';
import {
  DEFAULT_MCP_PORT,
  createClientRecord,
  isValidPort,
  normalizeMcpConfig,
  normalizeScopes,
  removeClient,
  rotateClientToken,
  sanitizeMcpConfig,
  touchClient,
  updateClientRecord,
  verifyToken,
} from '../../electron/mcp/config.js';

function configWith(overrides = {}) {
  return normalizeMcpConfig({
    enabled: true,
    port: 49000,
    clients: [
      {
        id: 'mcp_a',
        name: 'Claude',
        prefix: 'relay_mcp_abc123',
        tokenHash: 'a'.repeat(64),
        scopes: ['read'],
        approval: 'always',
        createdAt: 1,
        lastUsedAt: null,
      },
    ],
    ...overrides,
  });
}

describe('normalizeMcpConfig', () => {
  it('defaults a missing or invalid config to disabled + default port', () => {
    const empty = normalizeMcpConfig(null);
    expect(empty.enabled).toBe(false);
    expect(empty.port).toBe(DEFAULT_MCP_PORT);
    expect(empty.clients).toEqual([]);

    expect(normalizeMcpConfig({ enabled: 'yes', port: 80 }).port).toBe(DEFAULT_MCP_PORT);
    expect(normalizeMcpConfig({ port: 70000 }).port).toBe(DEFAULT_MCP_PORT);
    expect(normalizeMcpConfig({ port: '47821' }).port).toBe(DEFAULT_MCP_PORT);
  });

  it('drops unknown scopes and falls back to read', () => {
    const config = normalizeMcpConfig({
      clients: [{ name: 'X', scopes: ['write', 'teleport', 'read'], approval: 'session' }],
    });
    expect(config.clients[0].scopes).toEqual(['read', 'write']);
    expect(normalizeScopes(['nope'])).toEqual([]);

    const emptyScopes = normalizeMcpConfig({ clients: [{ name: 'Y', scopes: [] }] });
    expect(emptyScopes.clients[0].scopes).toEqual(['read']);
  });

  it('falls back to the always approval policy and trims names', () => {
    const config = normalizeMcpConfig({
      clients: [{ name: '  Spaced  ', approval: 'sometimes' }],
    });
    expect(config.clients[0].name).toBe('Spaced');
    expect(config.clients[0].approval).toBe('always');
  });

  it('drops unnamed and duplicate (case-insensitive) clients', () => {
    const config = normalizeMcpConfig({
      clients: [
        { name: 'Builder' },
        { name: 'builder' },
        { name: '   ' },
        { name: 'Reader' },
      ],
    });
    expect(config.clients.map((c) => c.name)).toEqual(['Builder', 'Reader']);
  });

  it('caps the client list at 20', () => {
    const clients = Array.from({ length: 30 }, (_, i) => ({ name: `Client ${i}` }));
    expect(normalizeMcpConfig({ clients }).clients).toHaveLength(20);
  });
});

describe('sanitizeMcpConfig', () => {
  it('never returns a token hash', () => {
    const sanitized = sanitizeMcpConfig(configWith());
    expect(JSON.stringify(sanitized)).not.toContain('tokenHash');
    expect(sanitized.clients[0]).toEqual({
      id: 'mcp_a',
      name: 'Claude',
      prefix: 'relay_mcp_abc123',
      scopes: ['read'],
      approval: 'always',
      createdAt: 1,
      lastUsedAt: null,
    });
  });
});

describe('createClientRecord', () => {
  it('issues a relay_mcp_ token and stores only its digest and prefix', () => {
    const { client, token } = createClientRecord({ name: 'Builder', scopes: ['read', 'write'] });
    expect(token.startsWith('relay_mcp_')).toBe(true);
    expect(token).toHaveLength('relay_mcp_'.length + 32);
    expect(client.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(client.prefix).toBe(token.slice(0, 'relay_mcp_'.length + 6));
    expect(client.scopes).toEqual(['read', 'write']);
    expect(client.approval).toBe('always');
    expect(client.id).toMatch(/^mcp_[0-9a-f]{12}$/);
    expect(JSON.stringify(client)).not.toContain(token);
  });

  it('rejects a missing name, an unknown scope and a bad policy', () => {
    expect(() => createClientRecord({ name: '  ' })).toThrow(/name is required/i);
    expect(() => createClientRecord({ name: 'A', scopes: ['nope'] })).toThrow(/unknown scope/i);
    expect(() => createClientRecord({ name: 'A', approval: 'sometimes' })).toThrow(/approval/i);
  });

  it('refuses duplicate names and a full client list', () => {
    const config = configWith();
    expect(() => createClientRecord({ name: 'claude' }, config)).toThrow(/already exists/i);

    const full = normalizeMcpConfig({
      clients: Array.from({ length: 20 }, (_, i) => ({ name: `C${i}` })),
    });
    expect(() => createClientRecord({ name: 'New' }, full)).toThrow(/at most 20/i);
  });
});

describe('verifyToken', () => {
  it('finds the client whose token matches and rejects anything else', () => {
    const { client, token } = createClientRecord({ name: 'Builder' });
    const config = normalizeMcpConfig({ clients: [client] });
    expect(verifyToken(config, token)?.id).toBe(client.id);
    expect(verifyToken(config, 'relay_mcp_wrong')).toBeNull();
    expect(verifyToken(config, '')).toBeNull();
    expect(verifyToken(config, null)).toBeNull();
  });
});

describe('updateClientRecord / removeClient / rotateClientToken', () => {
  it('renames, re-scopes and rejects duplicate names', () => {
    const config = configWith();
    const renamed = updateClientRecord(config, 'mcp_a', { name: 'Claude 2' });
    expect(renamed.ok).toBe(true);
    expect(renamed.client.name).toBe('Claude 2');

    const rescoped = updateClientRecord(config, 'mcp_a', { scopes: ['read', 'mock'] });
    expect(rescoped.client.scopes).toEqual(['read', 'mock']);

    const second = updateClientRecord(config, 'mcp_a', { name: 'X' });
    const clash = updateClientRecord(second.config, 'mcp_a', { name: 'X' });
    expect(clash.ok).toBe(true);

    const duplicateConfig = normalizeMcpConfig({
      clients: [
        { id: 'a', name: 'One' },
        { id: 'b', name: 'Two' },
      ],
    });
    expect(updateClientRecord(duplicateConfig, 'b', { name: 'one' }).ok).toBe(false);
    expect(updateClientRecord(config, 'missing', { name: 'Nope' }).ok).toBe(false);
  });

  it('removes a client and reports unknown ids', () => {
    const config = configWith();
    const removed = removeClient(config, 'mcp_a');
    expect(removed.ok).toBe(true);
    expect(removed.config.clients).toEqual([]);
    expect(removeClient(config, 'missing').ok).toBe(false);
  });

  it('rotates the token so the old one stops working', () => {
    const { client, token } = createClientRecord({ name: 'Builder' });
    const config = normalizeMcpConfig({ clients: [client] });
    const rotated = rotateClientToken(config, client.id);
    expect(rotated.ok).toBe(true);
    expect(rotated.token).not.toBe(token);
    expect(verifyToken(rotated.config, token)).toBeNull();
    expect(verifyToken(rotated.config, rotated.token)?.id).toBe(client.id);
  });
});

describe('touchClient', () => {
  it('writes lastUsedAt at most once per minute', () => {
    const config = configWith();
    const first = touchClient(config, 'mcp_a', 1_000_000);
    expect(first.changed).toBe(true);
    expect(first.config.clients[0].lastUsedAt).toBe(1_000_000);

    const second = touchClient(first.config, 'mcp_a', 1_030_000);
    expect(second.changed).toBe(false);

    const third = touchClient(first.config, 'mcp_a', 1_070_000);
    expect(third.changed).toBe(true);
  });
});

describe('isValidPort', () => {
  it('accepts 1024..65535 integers only', () => {
    expect(isValidPort(1024)).toBe(true);
    expect(isValidPort(65535)).toBe(true);
    expect(isValidPort(1023)).toBe(false);
    expect(isValidPort(65536)).toBe(false);
    expect(isValidPort(47821.5)).toBe(false);
    expect(isValidPort('47821')).toBe(false);
  });
});

describe('store mcp config', () => {
  it('persists the config and survives a renderer save', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-mcp-store-'));
    const file = path.join(dir, 'data.json');
    try {
      const store = createStore(file);
      expect(store.getMcpConfig()).toEqual({ enabled: false, port: DEFAULT_MCP_PORT, clients: [] });

      store.setMcpConfig({
        enabled: true,
        port: 49001,
        clients: [
          {
            id: 'mcp_a',
            name: 'A',
            prefix: 'relay_mcp_abcdef',
            tokenHash: 'h'.repeat(64),
            scopes: ['read'],
            approval: 'always',
            createdAt: 1,
            lastUsedAt: null,
          },
        ],
      });

      // The renderer never receives `mcp`, so its save cannot carry it. The
      // main process must keep the stored value.
      store.setAll({ schemaVersion: 3, workspaces: [], activeWorkspaceId: null });
      expect(store.getMcpConfig().enabled).toBe(true);
      expect(store.getMcpConfig().port).toBe(49001);
      expect(store.getAll().workspaces).toEqual([]);

      const reopened = createStore(file);
      expect(reopened.getMcpConfig().clients[0].tokenHash).toBe('h'.repeat(64));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
