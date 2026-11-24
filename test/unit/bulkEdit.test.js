import { describe, expect, it } from 'vitest';
import { bulkRowsToText, bulkTextToRows } from '../../src/lib/bulkEdit.js';

describe('bulk edit text', () => {
  it('round-trips header rows and preserves disabled state', () => {
    const rows = [
      { key: 'Accept', value: 'application/json', enabled: true },
      { key: 'X-Debug', value: '1', enabled: false },
    ];
    const text = bulkRowsToText(rows, { format: 'header' });
    expect(text).toBe('Accept: application/json\n# X-Debug: 1');
    expect(bulkTextToRows(text, { format: 'header' })).toEqual(rows);
  });

  it('parses form fields with equals signs and comments', () => {
    const rows = bulkTextToRows(
      'name=Ada\n# disabled=yes\n\n# comment\nquery=a=b',
      { format: 'form' }
    );
    expect(rows).toEqual([
      { key: 'name', value: 'Ada', enabled: true, type: 'text' },
      { key: 'disabled', value: 'yes', enabled: false, type: 'text' },
      { key: 'query', value: 'a=b', enabled: true, type: 'text' },
    ]);
  });

  it('keeps file rows when applying a text-only form edit', () => {
    const file = { key: 'avatar', value: '', type: 'file', fileName: 'a.png', enabled: true };
    expect(
      bulkTextToRows('name=Ada', { format: 'form', keepRows: [file] })
    ).toEqual([
      { key: 'name', value: 'Ada', enabled: true, type: 'text' },
      file,
    ]);
  });
});
