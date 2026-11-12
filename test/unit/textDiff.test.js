import { describe, expect, it } from 'vitest';
import { diffLines, prettyForDiff } from '../../src/lib/textDiff.js';

describe('response line diff', () => {
  it('marks unchanged, removed, and added lines', () => {
    const ops = diffLines('a\nb\nc', 'a\nB\nc');
    expect(ops).toEqual([
      { type: 'same', text: 'a' },
      { type: 'remove', text: 'b' },
      { type: 'add', text: 'B' },
      { type: 'same', text: 'c' },
    ]);
  });

  it('handles empty sides', () => {
    expect(diffLines('', 'x')).toEqual([
      { type: 'remove', text: '' },
      { type: 'add', text: 'x' },
    ]);
  });

  it('pretty-prints JSON before comparing', () => {
    expect(prettyForDiff('{"b":2,"a":1}')).toBe('{\n  "b": 2,\n  "a": 1\n}');
    expect(prettyForDiff('plain')).toBe('plain');
  });
});
