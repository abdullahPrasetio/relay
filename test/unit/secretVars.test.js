import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectSecretValues,
  hydrateSecretRows,
  hydrateWorkspaceSecrets,
  isSecretRow,
  sealSecretRows,
  sealWorkspaceSecrets,
} from '../../src/lib/secretVars.js';

describe('secretVars', () => {
  let originalWindow;

  beforeEach(() => {
    originalWindow = globalThis.window;
  });

  afterEach(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });

  it('detects secret rows', () => {
    expect(isSecretRow({ type: 'secret' })).toBe(true);
    expect(isSecretRow({ type: 'default' })).toBe(false);
    expect(isSecretRow(null)).toBe(false);
  });

  describe('hydrateSecretRows', () => {
    it('decrypts secret rows and leaves every other row untouched', async () => {
      globalThis.window = {
        api: {
          decryptSecrets: async (list) => list.map((c) => `plain:${c}`),
        },
      };
      const plain = { key: 'visible', value: 'hello' };
      const row = { key: 'token', type: 'secret', value: '', secretEnc: 'cipher-1' };
      const blank = { key: 'empty', type: 'secret', value: '', secretEnc: '' };

      const out = await hydrateSecretRows([plain, row, blank]);

      expect(out[1]).toEqual({ ...row, value: 'plain:cipher-1' });
      expect(out[0]).toBe(plain);
      expect(out[2]).toBe(blank);
      expect(row.value).toBe('');
    });

    it('falls back to per-row decryptSecret when decryptMany is absent', async () => {
      globalThis.window = {
        api: { decryptSecret: async (c) => (c === 'bad' ? Promise.reject(new Error('nope')) : 'ok') },
      };
      const out = await hydrateSecretRows([
        { key: 'a', type: 'secret', secretEnc: 'good' },
        { key: 'b', type: 'secret', secretEnc: 'bad' },
      ]);
      expect(out.map((r) => r.value)).toEqual(['ok', '']);
    });

    it('never throws when the bridge is absent or decryption fails', async () => {
      delete globalThis.window;
      const row = { key: 'a', type: 'secret', secretEnc: 'cipher' };
      await expect(hydrateSecretRows([row])).resolves.toEqual([{ ...row, value: '' }]);

      globalThis.window = {
        api: {
          decryptSecrets: async () => {
            throw new Error('Secure storage is unavailable');
          },
        },
      };
      await expect(hydrateSecretRows([row])).resolves.toEqual([{ ...row, value: '' }]);
    });

    it('accepts non-arrays', async () => {
      await expect(hydrateSecretRows(undefined)).resolves.toEqual([]);
      await expect(hydrateSecretRows(null)).resolves.toEqual([]);
    });
  });

  describe('sealSecretRows', () => {
    it('encrypts plaintext secret rows and clears the plaintext', async () => {
      globalThis.window = { api: { encryptSecret: async (v) => `enc:${v}` } };
      const out = await sealSecretRows([
        { key: 'token', type: 'secret', value: 's3cr3t', secretEnc: '' },
      ]);
      expect(out).toEqual([{ key: 'token', type: 'secret', value: '', secretEnc: 'enc:s3cr3t' }]);
    });

    it('preserves existing ciphertext when the value is blank', async () => {
      globalThis.window = { api: { encryptSecret: async () => 'should-not-run' } };
      const row = { key: 'token', type: 'secret', value: '', secretEnc: 'old-cipher' };
      const out = await sealSecretRows([row]);
      expect(out[0]).toBe(row);
      expect(out[0].secretEnc).toBe('old-cipher');
    });

    it('returns non-secret rows byte-identically', async () => {
      globalThis.window = { api: { encryptSecret: async () => 'enc' } };
      const row = { key: 'visible', value: 'plain' };
      const out = await sealSecretRows([row]);
      expect(out[0]).toBe(row);
      expect(out[0]).toEqual({ key: 'visible', value: 'plain' });
    });

    it('keeps plaintext with no ciphertext when no bridge exists (dev only)', async () => {
      delete globalThis.window;
      const row = { key: 'token', type: 'secret', value: 's3cr3t' };
      const out = await sealSecretRows([row]);
      expect(out[0]).toBe(row);
      expect(out[0]).toEqual({ key: 'token', type: 'secret', value: 's3cr3t' });
      expect(out[0].secretEnc).toBeUndefined();
    });

    it('propagates encryption failures so the caller can report them', async () => {
      globalThis.window = {
        api: {
          encryptSecret: async () => {
            throw new Error('Secure storage is unavailable; cannot persist secrets');
          },
        },
      };
      await expect(
        sealSecretRows([{ key: 'token', type: 'secret', value: 'x' }])
      ).rejects.toThrow(/Secure storage is unavailable/);
    });
  });

  describe('collectSecretValues', () => {
    it('collects plaintext from secret rows only, skipping short values', () => {
      const env = [
        { key: 'a', type: 'secret', value: 'abcdef' },
        { key: 'b', type: 'secret', value: 'x' },
        { key: 'c', value: 'not-a-secret' },
      ];
      const globals = { variables: [{ key: 'd', type: 'secret', value: 'global-secret' }] };
      expect(collectSecretValues(env, globals)).toEqual(['abcdef', 'global-secret']);
      expect(collectSecretValues(undefined, null)).toEqual([]);
    });
  });

  describe('workspace traversal', () => {
    const toB64 = (value) => Buffer.from(value, 'utf8').toString('base64');
    const fromB64 = (encoded) => Buffer.from(encoded, 'base64').toString('utf8');

    function installBridge() {
      globalThis.window = {
        api: {
          encryptSecret: async (value) => toB64(value),
          decryptSecret: async (encoded) => fromB64(encoded),
          decryptSecrets: async (list) => list.map(fromB64),
        },
      };
    }

    // Collection variables, nested folders, requests, environment, globals.
    // Request nodes carry no variables today; one is included to prove the
    // traversal stays future-proof, not because the model uses it.
    function makeWorkspaces() {
      const visible = { key: 'visible', value: 'plain-text' };
      const colSecret = { key: 'colSecret', type: 'secret', value: 'col-pass' };
      const reqSecret = { key: 'reqSecret', type: 'secret', value: 'req-pass' };
      const envSecret = { key: 'envSecret', type: 'secret', value: 'env-pass' };
      const gSecret = { key: 'gSecret', type: 'secret', value: 'g-pass' };
      return {
        rows: { visible, colSecret, reqSecret, envSecret, gSecret },
        workspaces: [
          {
            id: 'ws1',
            name: 'Workspace',
            collections: [
              {
                id: 'col1',
                name: 'Collection',
                variables: [colSecret],
                items: [
                  {
                    id: 'fld1',
                    type: 'folder',
                    name: 'Folder',
                    items: [
                      { id: 'req1', type: 'request', name: 'Request', variables: [reqSecret] },
                      {
                        id: 'fld2',
                        type: 'folder',
                        name: 'Nested',
                        items: [{ id: 'req2', type: 'request', name: 'Inner' }],
                      },
                    ],
                  },
                ],
              },
            ],
            environments: [{ id: 'env1', name: 'Env', variables: [visible, envSecret] }],
            globals: [gSecret],
            history: [],
          },
        ],
      };
    }

    function allRows(workspace) {
      const rows = [...(workspace.globals || [])];
      for (const env of workspace.environments || []) rows.push(...(env.variables || []));
      const walk = (items) => {
        for (const item of items || []) {
          if (Array.isArray(item.variables)) rows.push(...item.variables);
          walk(item.items);
        }
      };
      for (const collection of workspace.collections || []) {
        rows.push(...(collection.variables || []));
        walk(collection.items);
      }
      return rows;
    }

    it('seals every scope without mutating the input or touching non-secrets', async () => {
      installBridge();
      const { workspaces, rows } = makeWorkspaces();
      const snapshot = JSON.parse(JSON.stringify(workspaces));

      const sealed = await sealWorkspaceSecrets(workspaces);

      expect(workspaces).toEqual(snapshot); // input untouched
      expect(sealed).not.toBe(workspaces);

      const sealedRows = allRows(sealed[0]);
      expect(sealedRows.map((r) => r.key)).toEqual([
        'gSecret',
        'visible',
        'envSecret',
        'colSecret',
        'reqSecret',
      ]);
      const expected = {
        gSecret: 'g-pass',
        envSecret: 'env-pass',
        colSecret: 'col-pass',
        reqSecret: 'req-pass',
      };
      for (const row of sealedRows) {
        if (row.type === 'secret') {
          expect(row.value).toBe('');
          expect(fromB64(row.secretEnc)).toBe(expected[row.key]);
        }
      }
      expect(sealedRows.filter((r) => r.type !== 'secret')).toEqual([rows.visible]);
      // Non-secret rows keep identity and content.
      const sealedVisible = sealed[0].environments[0].variables[0];
      expect(sealedVisible).toBe(rows.visible);
      expect(sealedVisible).toEqual({ key: 'visible', value: 'plain-text' });

      // Nested folder structure is preserved.
      const folder = sealed[0].collections[0].items[0];
      expect(folder.id).toBe('fld1');
      expect(folder.items.map((i) => i.id)).toEqual(['req1', 'fld2']);
      expect(folder.items[1].items[0].id).toBe('req2');
    });

    it('hydrates every scope and restores plaintext in a round trip', async () => {
      installBridge();
      const { workspaces } = makeWorkspaces();

      const sealed = await sealWorkspaceSecrets(workspaces);
      const hydrated = await hydrateWorkspaceSecrets(sealed);

      const values = Object.fromEntries(allRows(hydrated[0]).map((r) => [r.key, r.value]));
      expect(values).toEqual({
        gSecret: 'g-pass',
        visible: 'plain-text',
        envSecret: 'env-pass',
        colSecret: 'col-pass',
        reqSecret: 'req-pass',
      });
      // Original plaintext object was never modified.
      expect(Object.fromEntries(allRows(workspaces[0]).map((r) => [r.key, r.value]))).toEqual({
        gSecret: 'g-pass',
        visible: 'plain-text',
        envSecret: 'env-pass',
        colSecret: 'col-pass',
        reqSecret: 'req-pass',
      });
      // Ciphertext is gone from the plaintext view? It is retained as a
      // fallback, but the value is plaintext so inputs can render/edit it.
      expect(allRows(hydrated[0]).every((r) => r.type !== 'secret' || r.value !== '')).toBe(true);
    });

    it('is a no-op without a bridge (browser dev keeps plaintext)', async () => {
      delete globalThis.window;
      const { workspaces } = makeWorkspaces();
      await expect(sealWorkspaceSecrets(workspaces)).resolves.toBe(workspaces);
      await expect(hydrateWorkspaceSecrets(workspaces)).resolves.toBe(workspaces);
    });
  });
});
