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

  it('still migrates legacy flat requests[] into request nodes', () => {
    const collection = normalizeCollection({
      name: 'Legacy',
      requests: [{ id: 'r1', name: 'R', method: 'GET', url: 'https://x.test' }],
    });
    expect(collection.items).toHaveLength(1);
    expect(collection.items[0]).toMatchObject({ id: 'r1', type: 'request' });
  });
});
