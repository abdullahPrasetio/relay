import { describe, expect, it } from 'vitest';
import { normalizeCollection } from '../../src/lib/collectionTree.js';

describe('collection normalization', () => {
  it('keeps an untrusted marker across a reload', () => {
    expect(normalizeCollection({ name: 'Imported', scriptsTrusted: false }).scriptsTrusted).toBe(
      false
    );
    expect(normalizeCollection({ name: 'Local', scriptsTrusted: true }).scriptsTrusted).toBe(true);
    // Legacy data has no marker: trusted by default.
    expect(normalizeCollection({ name: 'Legacy' }).scriptsTrusted).toBe(true);
  });

  it('normalizes legacy variable rows and keeps secret ciphertext', () => {
    const collection = normalizeCollection({
      name: 'Vars',
      variables: [
        { key: 'old', value: 'x' },
        { key: 's', value: '', type: 'secret', secretEnc: 'c===' },
      ],
    });
    expect(collection.variables[0]).toMatchObject({ key: 'old', type: 'default' });
    expect(collection.variables[1]).toMatchObject({ key: 's', type: 'secret', secretEnc: 'c===' });
  });

  it('keeps Confluence destination metadata across a reload', () => {
    const collection = normalizeCollection({
      name: 'Docs',
      confluencePageId: '123',
      confluencePageUrl: 'https://org.test/wiki/pages/123',
      confluenceTitle: 'Docs page',
      confluenceSpaceKey: 'DOCS',
      confluenceParentPageId: '456',
      confluenceSyncedAt: '2026-10-31T00:00:00.000Z',
      confluenceVersion: 4,
    });
    expect(collection).toMatchObject({
      confluencePageId: '123',
      confluencePageUrl: 'https://org.test/wiki/pages/123',
      confluenceTitle: 'Docs page',
      confluenceSpaceKey: 'DOCS',
      confluenceParentPageId: '456',
      confluenceSyncedAt: '2026-10-31T00:00:00.000Z',
      confluenceVersion: 4,
    });
    expect(normalizeCollection({ name: 'Plain' }).confluencePageId).toBe('');
    expect(normalizeCollection({ name: 'Bad', confluenceVersion: -1 }).confluenceVersion).toBeNull();
  });

  it('still migrates legacy flat requests[] into request nodes', () => {
    const collection = normalizeCollection({
      name: 'Legacy',
      requests: [{ id: 'r1', name: 'R', method: 'GET', url: 'https://x.test' }],
    });
    expect(collection.items).toHaveLength(1);
    expect(collection.items[0]).toMatchObject({ id: 'r1', type: 'request' });
  });
});
