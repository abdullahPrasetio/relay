import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStore } from '../../electron/store.js';
import { deleteCookie, pruneExpired, upsertCookie } from '../../packages/core/src/cookie-jar.js';
import { clampHistoryLimit, DEFAULT_HISTORY_LIMIT } from '../../src/lib/useStore.js';

let dir;
let file;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'relay-store-'));
  file = path.join(dir, 'data.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('main-process store', () => {
  it('persists network settings across store instances', () => {
    const store = createStore(file);
    const network = { ...store.getNetworkSettings(), timeoutMs: 1234 };
    store.setNetworkSettings(network);

    const reopened = createStore(file);
    expect(reopened.getNetworkSettings().timeoutMs).toBe(1234);
  });

  it('keeps network settings when the renderer saves workspace data', () => {
    const store = createStore(file);
    store.setNetworkSettings({ ...store.getNetworkSettings(), timeoutMs: 4321 });

    store.setAll({ schemaVersion: 2, workspaces: [], activeWorkspaceId: null });

    expect(store.getAll().workspaces).toEqual([]);
    expect(store.getNetworkSettings().timeoutMs).toBe(4321);
    expect(createStore(file).getNetworkSettings().timeoutMs).toBe(4321);
  });

  it('persists the selected cloud API URL across renderer saves', () => {
    const store = createStore(file);
    store.setCloudBaseUrl('http://relay.example/api/v1');

    store.setAll({ workspaces: [], activeWorkspaceId: null });

    expect(store.getCloudBaseUrl()).toBe('http://relay.example/api/v1');
    expect(createStore(file).getCloudBaseUrl()).toBe('http://relay.example/api/v1');
  });

  it('keeps the cookie jar when the renderer omits it', () => {
    const store = createStore(file);
    store.setCookieJar([{ name: 'a', value: 'b' }]);

    store.setAll({ workspaces: [], activeWorkspaceId: null });

    expect(store.getCookieJar()).toEqual([{ name: 'a', value: 'b' }]);
  });

  it('takes a one-time backup of the pre-migration file', () => {
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, workspaces: [{ id: 'ws_old' }] }));
    const store = createStore(file);

    const backupPath = store.backup('v1');
    expect(backupPath).toBe(`${file}.v1.bak`);
    const backedUp = JSON.parse(readFileSync(backupPath, 'utf8'));
    expect(backedUp.schemaVersion).toBe(1);
    expect(backedUp.workspaces[0].id).toBe('ws_old');

    // A later write (the migrated data) must not clobber the backup.
    store.setAll({ schemaVersion: 2, workspaces: [], activeWorkspaceId: null });
    expect(JSON.parse(readFileSync(backupPath, 'utf8')).schemaVersion).toBe(1);
    expect(store.backup('v1')).toBe(backupPath);
  });

  it('does not create a backup on a fresh install', () => {
    expect(createStore(file).backup('v1')).toBeNull();
  });

  it('persists a manually added cookie across renderer saves and store instances', () => {
    const store = createStore(file);
    const added = upsertCookie(pruneExpired(store.getCookieJar()), {
      name: 'sid',
      value: 'v1',
      domain: 'Example.com',
      path: '/',
    });
    store.setCookieJar(added);

    // Renderer workspace saves must not clobber the main-process jar.
    store.setAll({ workspaces: [], activeWorkspaceId: null });

    expect(store.getCookieJar()).toEqual(added);
    expect(createStore(file).getCookieJar()).toEqual(added);
  });

  it('persists a manual cookie delete and prunes expired entries', () => {
    const store = createStore(file);
    const now = Date.now();
    const seed = [
      { name: 'keep', value: '1', domain: 'example.com', path: '/', expires: null },
      { name: 'stale', value: '2', domain: 'example.com', path: '/', expires: now - 1000 },
      { name: 'drop', value: '3', domain: 'example.com', path: '/' },
    ];

    // cookies:set = prune expired, then upsert.
    const afterSet = upsertCookie(pruneExpired(seed), {
      name: 'drop',
      value: '3',
      domain: 'example.com',
      path: '/',
    });
    store.setCookieJar(afterSet);
    expect(afterSet.map((c) => c.name)).toEqual(['keep', 'drop']);

    // cookies:delete removes only the matching identity.
    const afterDelete = deleteCookie(afterSet, {
      name: 'drop',
      domain: 'example.com',
      path: '/',
    });
    store.setCookieJar(afterDelete);

    expect(store.getCookieJar().map((c) => c.name)).toEqual(['keep']);
    expect(createStore(file).getCookieJar().map((c) => c.name)).toEqual(['keep']);
  });
});

describe('history retention limit', () => {
  it('clamps the retention input to 10..1000', () => {
    expect(clampHistoryLimit(10)).toBe(10);
    expect(clampHistoryLimit(1000)).toBe(1000);
    expect(clampHistoryLimit(1)).toBe(10);
    expect(clampHistoryLimit(5000)).toBe(1000);
    expect(clampHistoryLimit('250')).toBe(250);
    expect(clampHistoryLimit(12.9)).toBe(12);
  });

  it('falls back to the default for non-numeric input', () => {
    expect(clampHistoryLimit('')).toBe(DEFAULT_HISTORY_LIMIT);
    expect(clampHistoryLimit('nope')).toBe(DEFAULT_HISTORY_LIMIT);
    expect(clampHistoryLimit(null)).toBe(DEFAULT_HISTORY_LIMIT);
  });
});
