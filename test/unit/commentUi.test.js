import { describe, expect, it } from 'vitest';
import {
  COMMENT_MAX_LENGTH,
  authorLabel,
  authorShortId,
  canModifyComment,
  commentCountLabel,
  commentDateTime,
  commentTime,
  hasMoreComments,
  isResolved,
  mergeComments,
  normalizeCommentsPayload,
  normalizeNextBefore,
  resolveActionLabel,
  resolveLabel,
  sortCommentsNewestFirst,
  validateCommentBody,
} from '../../src/lib/commentUi.js';

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);

function comment(id, createdAt, extra = {}) {
  return {
    id,
    entityId: 'req_1',
    userId: `user_${id}`,
    body: `Body ${id}`,
    createdAt,
    updatedAt: createdAt,
    ...extra,
  };
}

describe('authorShortId', () => {
  it('truncates long ids and keeps short ones', () => {
    expect(authorShortId('user_0123456789abcdef', 8)).toBe('user_012');
    expect(authorShortId('u1')).toBe('u1');
  });

  it('handles empty values', () => {
    expect(authorShortId(null)).toBe('');
    expect(authorShortId(undefined)).toBe('');
    expect(authorShortId('   ')).toBe('');
    expect(authorLabel(null)).toBe('Unknown author');
    expect(authorLabel('u1')).toBe('u1');
  });

  it('trims whitespace before truncating', () => {
    expect(authorShortId('  user_123456789  ', 6)).toBe('user_1');
  });
});

describe('commentTime', () => {
  it('formats recent timestamps relatively', () => {
    expect(commentTime(new Date(NOW - 5 * 60 * 1000).toISOString(), NOW)).toBe('5m ago');
    expect(commentTime(new Date(NOW - 30 * 1000).toISOString(), NOW)).toBe('just now');
    expect(commentTime(new Date(NOW - 3 * 60 * 60 * 1000).toISOString(), NOW)).toBe('3h ago');
  });

  it('falls back to a UTC timestamp after a week and ignores garbage', () => {
    expect(commentTime(NOW - 10 * 24 * 60 * 60 * 1000, NOW)).toBe('2026-10-20 12:00 UTC');
    expect(commentTime('not-a-date', NOW)).toBe('');
    expect(commentTime(null, NOW)).toBe('');
  });

  it('exposes an absolute title formatter', () => {
    expect(commentDateTime(NOW)).toBe('2026-10-30 12:00 UTC');
  });
});

describe('resolve labels', () => {
  it('reads resolvedAt and the resolved flag', () => {
    expect(isResolved({ resolvedAt: '2026-10-30T12:00:00Z' })).toBe(true);
    expect(isResolved({ resolvedAt: null })).toBe(false);
    expect(isResolved({ resolved: true })).toBe(true);
    expect(isResolved({})).toBe(false);
  });

  it('labels the state and the next action', () => {
    expect(resolveLabel({ resolvedAt: '2026-10-30T12:00:00Z' })).toBe('Resolved');
    expect(resolveLabel({ resolvedAt: null })).toBe('Open');
    expect(resolveLabel(true)).toBe('Resolved');
    expect(resolveActionLabel({ resolvedAt: '2026-10-30T12:00:00Z' })).toBe('Unresolve');
    expect(resolveActionLabel({})).toBe('Resolve');
  });
});

describe('sortCommentsNewestFirst', () => {
  it('orders newest first without mutating the input', () => {
    const list = [
      comment('a', '2026-10-30T10:00:00Z'),
      comment('b', '2026-10-30T12:00:00Z'),
      comment('c', '2026-10-30T11:00:00Z'),
    ];
    expect(sortCommentsNewestFirst(list).map((entry) => entry.id)).toEqual(['b', 'c', 'a']);
    expect(list.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps undated entries after dated ones in input order', () => {
    const list = [
      comment('undated-1', null),
      comment('dated', '2026-10-30T10:00:00Z'),
      comment('undated-2', 'garbage'),
    ];
    expect(sortCommentsNewestFirst(list).map((entry) => entry.id)).toEqual([
      'dated',
      'undated-1',
      'undated-2',
    ]);
  });

  it('tolerates non-array input', () => {
    expect(sortCommentsNewestFirst(null)).toEqual([]);
  });
});

describe('mergeComments', () => {
  it('deduplicates by id and prefers the newer copy', () => {
    const existing = [comment('a', '2026-10-30T10:00:00Z', { body: 'old' })];
    const incoming = [comment('a', '2026-10-30T10:00:00Z', { body: 'new' })];
    const merged = mergeComments(existing, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0].body).toBe('new');
  });

  it('orders merged pages newest first and keeps anonymous entries', () => {
    const merged = mergeComments(
      [comment('a', '2026-10-30T10:00:00Z')],
      [comment('b', '2026-10-30T12:00:00Z'), { body: 'no id' }]
    );
    expect(merged.map((entry) => entry.id || 'anonymous')).toEqual(['b', 'a', 'anonymous']);
  });

  it('skips non-object entries', () => {
    expect(mergeComments([], [null, 'x', 3])).toEqual([]);
  });
});

describe('cursor handling', () => {
  it('normalises nextBefore values', () => {
    expect(normalizeNextBefore({ nextBefore: 'cmt_9' })).toBe('cmt_9');
    expect(normalizeNextBefore({ nextBefore: 0 })).toBe('0');
    expect(normalizeNextBefore({ nextBefore: '' })).toBe(null);
    expect(normalizeNextBefore({ nextBefore: '   ' })).toBe(null);
    expect(normalizeNextBefore({ nextBefore: null })).toBe(null);
    expect(normalizeNextBefore({})).toBe(null);
    expect(normalizeNextBefore(null)).toBe(null);
  });

  it('accepts a snake_case cursor from older bridges', () => {
    expect(normalizeNextBefore({ next_before: 'cmt_4' })).toBe('cmt_4');
  });

  it('reports whether another page exists', () => {
    expect(hasMoreComments({ nextBefore: 'cmt_1' })).toBe(true);
    expect(hasMoreComments({ nextBefore: null })).toBe(false);
    expect(hasMoreComments({})).toBe(false);
  });
});

describe('normalizeCommentsPayload', () => {
  it('unwraps the comments envelope and sorts it', () => {
    const payload = {
      comments: [
        comment('a', '2026-10-30T09:00:00Z'),
        comment('b', '2026-10-30T11:00:00Z'),
      ],
      nextBefore: 'cmt_a',
    };
    const page = normalizeCommentsPayload(payload);
    expect(page.comments.map((entry) => entry.id)).toEqual(['b', 'a']);
    expect(page.nextBefore).toBe('cmt_a');
  });

  it('accepts a bare array with no cursor', () => {
    const page = normalizeCommentsPayload([comment('a', NOW)]);
    expect(page.comments.map((entry) => entry.id)).toEqual(['a']);
    expect(page.nextBefore).toBe(null);
  });

  it('returns an empty page for missing data', () => {
    expect(normalizeCommentsPayload(null)).toEqual({ comments: [], nextBefore: null });
    expect(normalizeCommentsPayload({ comments: 'nope' })).toEqual({
      comments: [],
      nextBefore: null,
    });
  });
});

describe('commentCountLabel', () => {
  it('pluralises counts', () => {
    expect(commentCountLabel([])).toBe('No comments');
    expect(commentCountLabel([comment('a', NOW)])).toBe('1 comment');
    expect(commentCountLabel(4)).toBe('4 comments');
    expect(commentCountLabel('7')).toBe('7 comments');
    expect(commentCountLabel(-2)).toBe('No comments');
  });
});

describe('validateCommentBody', () => {
  it('trims and accepts valid text', () => {
    expect(validateCommentBody('  hello  ')).toEqual({
      ok: true,
      value: 'hello',
      error: '',
    });
  });

  it('rejects empty and whitespace-only input', () => {
    for (const value of ['', '   ', null, undefined, 42]) {
      const result = validateCommentBody(value);
      expect(result.ok).toBe(false);
      expect(result.value).toBe('');
      expect(result.error).toMatch(/write a comment/i);
    }
  });

  it('enforces the 4000 character limit', () => {
    expect(commentBodyLength(COMMENT_MAX_LENGTH)).toEqual({
      ok: true,
      value: 'a'.repeat(COMMENT_MAX_LENGTH),
      error: '',
    });
    const tooLong = validateCommentBody('a'.repeat(COMMENT_MAX_LENGTH + 1));
    expect(tooLong.ok).toBe(false);
    expect(tooLong.error).toMatch(/4000/);
  });

  it('accepts a custom limit', () => {
    const result = validateCommentBody('abcd', { maxLength: 3 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/3 characters/);
  });

  it('counts trimmed characters, not surrounding whitespace', () => {
    const text = `  ${'a'.repeat(COMMENT_MAX_LENGTH)}  `;
    expect(validateCommentBody(text).ok).toBe(true);
  });
});

function commentBodyLength(length) {
  return validateCommentBody('a'.repeat(length));
}

describe('canModifyComment', () => {
  it('matches the author id', () => {
    expect(canModifyComment({ userId: 'u1' }, 'u1')).toBe(true);
    expect(canModifyComment({ userId: 'u1' }, 'u2')).toBe(false);
    expect(canModifyComment({ user_id: 'u1' }, 'u1')).toBe(true);
  });

  it('leaves the decision to the server when an id is missing', () => {
    expect(canModifyComment({ userId: 'u1' }, null)).toBe(true);
    expect(canModifyComment({}, 'u1')).toBe(true);
  });
});
