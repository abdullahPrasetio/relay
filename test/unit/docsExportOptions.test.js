import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DOCS_DISCLAIMER,
  DEFAULT_DOCS_OPTIONS,
  DOCS_EXPORT_OPTIONS_KEY,
  normalizeDocsOptions,
  readDocsOptions,
  writeDocsOptions,
} from '../../src/lib/docsExportOptions.js';

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    map,
  };
}

describe('documentation export options', () => {
  it('normalizes unknown values and keeps defaults', () => {
    const normalized = normalizeDocsOptions({
      template: 'neon',
      theme: 'sepia',
      accent: 'red',
      language: 'fr',
      includeExamples: false,
    });
    expect(normalized.template).toBe(DEFAULT_DOCS_OPTIONS.template);
    expect(normalized.theme).toBe(DEFAULT_DOCS_OPTIONS.theme);
    expect(normalized.accent).toBe(DEFAULT_DOCS_OPTIONS.accent);
    expect(normalized.language).toBe(DEFAULT_DOCS_OPTIONS.language);
    expect(normalized.includeExamples).toBe(false);
    expect(normalized.disclaimer).toBe(DEFAULT_DOCS_DISCLAIMER);
  });

  it('round-trips through storage', () => {
    const storage = memoryStorage();
    expect(writeDocsOptions({ ...DEFAULT_DOCS_OPTIONS, author: 'Alice', template: 'minimal' }, storage)).toBe(true);
    const saved = JSON.parse(storage.getItem(DOCS_EXPORT_OPTIONS_KEY));
    expect(saved.author).toBe('Alice');
    expect(readDocsOptions(storage)).toMatchObject({
      author: 'Alice',
      template: 'minimal',
    });
  });

  it('falls back when storage is absent or corrupt', () => {
    expect(readDocsOptions(null)).toMatchObject(DEFAULT_DOCS_OPTIONS);
    const corrupt = memoryStorage({ [DOCS_EXPORT_OPTIONS_KEY]: '{bad' });
    expect(readDocsOptions(corrupt)).toMatchObject(DEFAULT_DOCS_OPTIONS);
  });
});
