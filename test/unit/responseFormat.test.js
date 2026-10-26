import { describe, expect, it } from 'vitest';
import {
  detectLanguage,
  escapeHtml,
  findMatches,
  formatXml,
  highlightSegments,
  jsonSubtreeMatches,
  prettyText,
} from '../../src/lib/responseFormat.js';

describe('response formatting helpers', () => {
  it('escapes HTML so response bytes cannot inject markup', () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'
    );
  });

  it('finds non-overlapping case-insensitive matches', () => {
    expect(findMatches('ABCabcABC', 'abc')).toEqual([0, 3, 6]);
    expect(findMatches('aaaa', 'aa')).toEqual([0, 2]);
    expect(findMatches('text', '')).toEqual([]);
  });

  it('marks the current match and leaves the rest as plain segments', () => {
    const segments = highlightSegments('one TWO two', 'two', 1);
    expect(segments.map((s) => (s.match ? s.current : '-'))).toEqual(['-', false, '-', true]);
    expect(segments.map((s) => s.text).join('')).toBe('one TWO two');
  });

  it('wraps even when the current index is out of range', () => {
    const segments = highlightSegments('x x', 'x', 9);
    expect(segments.find((s) => s.match && s.current).text).toBe('x');
  });

  it('indents XML without changing the tags', () => {
    expect(formatXml('<a><b>text</b><c/></a>')).toBe(
      ['<a>', '  <b>', '    text', '  </b>', '  <c/>', '</a>'].join('\n')
    );
  });

  it('detects a language from the content type or body', () => {
    expect(detectLanguage('application/json; charset=utf-8', '')).toBe('json');
    expect(detectLanguage('application/xml', '')).toBe('xml');
    expect(detectLanguage('text/html', '')).toBe('html');
    expect(detectLanguage('application/javascript', '')).toBe('javascript');
    expect(detectLanguage('', '{"a":1}')).toBe('json');
    expect(detectLanguage('', '<root/>')).toBe('xml');
    expect(detectLanguage('text/plain', 'hello')).toBe('plaintext');
  });

  it('pretty-prints JSON and XML bodies', () => {
    expect(prettyText('application/json', '{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyText('application/xml', '<a><b/></a>')).toBe('<a>\n  <b/>\n</a>');
    expect(prettyText('text/plain', 'hello')).toBe('hello');
  });

  it('matches JSON branches by key and by nested path', () => {
    const value = { user: { name: 'Ada', address: { city: 'Paris' } }, id: 1 };
    expect(jsonSubtreeMatches('root', value, 'name', '')).toBe(true);
    expect(jsonSubtreeMatches('root', value, 'address.city', '')).toBe(true);
    expect(jsonSubtreeMatches('root', value, 'nope', '')).toBe(false);
    expect(jsonSubtreeMatches('root', value, '', '')).toBe(true);
  });
});
