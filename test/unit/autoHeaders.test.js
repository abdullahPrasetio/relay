import { describe, expect, it } from 'vitest';
import { computeAutoHeaders } from '../../packages/core/src/autoHeaders.js';

function contentTypes(body) {
  return computeAutoHeaders({ url: 'https://api.test/x', body })
    .filter((row) => row.key === 'Content-Type')
    .map((row) => row.value);
}

describe('raw body content type', () => {
  it('maps each raw format to a content type', () => {
    expect(contentTypes({ mode: 'raw', rawFormat: 'json' })).toEqual(['application/json']);
    expect(contentTypes({ mode: 'raw', rawFormat: 'javascript' })).toEqual([
      'application/javascript',
    ]);
    expect(contentTypes({ mode: 'raw', rawFormat: 'html' })).toEqual(['text/html']);
    expect(contentTypes({ mode: 'raw', rawFormat: 'xml' })).toEqual(['application/xml']);
    expect(contentTypes({ mode: 'raw', rawFormat: 'text' })).toEqual([]);
  });
});
