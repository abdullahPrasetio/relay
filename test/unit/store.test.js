import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStore } from '../../electron/store.js';

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

  it('keeps the cookie jar when the renderer omits it', () => {
    const store = createStore(file);
    store.setCookieJar([{ name: 'a', value: 'b' }]);

    store.setAll({ workspaces: [], activeWorkspaceId: null });

    expect(store.getCookieJar()).toEqual([{ name: 'a', value: 'b' }]);
  });
});
