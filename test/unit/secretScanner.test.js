import { describe, expect, it } from 'vitest';
import {
  looksLikeSecret,
  markSecretInWorkspace,
  scanWorkspaceSecrets,
} from '../../src/lib/secretScanner.js';

function workspace() {
  return {
    id: 'ws_scan',
    environments: [
      {
        id: 'env',
        name: 'Prod',
        variables: [
          { key: 'NEUTRAL', value: 'ghp_abcdefghijklmnopqrstuvwxyz123456', type: 'default' },
          { key: 'HOST', value: 'https://api.test', type: 'default' },
        ],
      },
    ],
    globals: [{ key: 'GLOBAL_TOKEN', value: 'x'.repeat(40), type: 'secret' }],
    collections: [
      {
        id: 'col',
        name: 'Orders',
        variables: [],
        items: [
          {
            id: 'fld',
            type: 'folder',
            name: 'Auth',
            variables: [
              { key: 'VALUE', value: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature123', type: 'default' },
            ],
            items: [],
          },
        ],
      },
    ],
  };
}

describe('secret scanner', () => {
  it('detects tokens under neutral names and skips URLs/secrets', () => {
    expect(looksLikeSecret('ghp_abcdefghijklmnopqrstuvwxyz123456')).toBe(true);
    expect(looksLikeSecret('https://api.test/path')).toBe(false);
    expect(looksLikeSecret('short')).toBe(false);
    expect(looksLikeSecret('ada@example.com')).toBe(false);
  });

  it('scans environments and folders without flagging existing secrets', () => {
    const hits = scanWorkspaceSecrets(workspace());
    expect(hits.map((hit) => hit.key)).toEqual(['NEUTRAL', 'VALUE']);
    expect(hits[0].scope).toBe('environment');
    expect(hits[1].scope).toBe('folder');
  });

  it('marks a folder variable secret without mutating the source', () => {
    const source = workspace();
    const [envHit, folderHit] = scanWorkspaceSecrets(source);
    const next = markSecretInWorkspace(source, folderHit);
    expect(next.collections[0].items[0].variables[0].type).toBe('secret');
    expect(source.collections[0].items[0].variables[0].type).toBe('default');
    expect(scanWorkspaceSecrets(next).map((hit) => hit.key)).toEqual(['NEUTRAL']);

    const envNext = markSecretInWorkspace(source, envHit);
    expect(envNext.environments[0].variables[0].type).toBe('secret');
  });
});
