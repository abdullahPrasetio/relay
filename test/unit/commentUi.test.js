import { describe, expect, it } from 'vitest';
import {
  COMMENT_MAX_LENGTH,
  authorDisplayName,
  authorLabel,
  authorShortId,
  buildMentionChips,
  canModifyComment,
  commentCountLabel,
  commentDateTime,
  commentMentions,
  commentTime,
  hasMoreComments,
  insertMentionDraft,
  isResolved,
  mentionBadgeLabel,
  mentionNames,
  mentionOptions,
  mentionsUser,
  mergeComments,
  mergeMentionPages,
  normalizeCommentsPayload,
  normalizeMentionsPayload,
  normalizeNextBefore,
  resolveActionLabel,
  resolveLabel,
  sortCommentsNewestFirst,
  splitMentionSegments,
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

describe('mentionOptions', () => {
  const members = [
    { userId: 'u1', name: 'Ada Lovelace', email: 'ada@relay.test', role: 'owner' },
    { userId: 'u2', name: 'Grace Hopper', email: 'grace@relay.test', role: 'editor' },
    { userId: 'u3', name: '', email: 'linus@relay.test', role: 'viewer' },
  ];

  it('drops the caller and sorts the remaining members by label', () => {
    const options = mentionOptions(members, 'u1');
    expect(options.map((option) => option.userId)).toEqual(['u2', 'u3']);
    expect(options[0]).toMatchObject({
      userId: 'u2',
      name: 'Grace Hopper',
      email: 'grace@relay.test',
      label: 'Grace Hopper',
    });
    expect(options[1].label).toBe('linus@relay.test');
  });

  it('deduplicates member ids and tolerates malformed entries', () => {
    const options = mentionOptions(
      [members[0], members[0], null, 'x', { name: 'no id' }, { userId: 'u9' }],
      'u1'
    );
    expect(options.map((option) => option.userId)).toEqual(['u9']);
    expect(options[0].label).toBe('u9');
  });

  it('keeps everyone when the caller is unknown', () => {
    expect(mentionOptions(members, null)).toHaveLength(3);
    expect(mentionOptions(null, 'u1')).toEqual([]);
  });
});

describe('buildMentionChips', () => {
  const members = [
    { userId: 'u1', name: 'Ada Lovelace', email: 'ada@relay.test' },
    { userId: 'u2', name: '', email: 'grace@relay.test' },
  ];

  it('resolves names and preserves selection order', () => {
    const chips = buildMentionChips(members, ['u2', 'u1']);
    expect(chips.map((chip) => chip.userId)).toEqual(['u2', 'u1']);
    expect(chips[0].label).toBe('grace@relay.test');
    expect(chips[1]).toMatchObject({ name: 'Ada Lovelace', label: 'Ada Lovelace' });
  });

  it('falls back to a short id for unknown or removed members', () => {
    expect(buildMentionChips(members, ['gone_0123456789'])).toEqual([
      { userId: 'gone_0123456789', name: '', email: '', label: 'gone_012' },
    ]);
  });

  it('deduplicates ids and ignores empty values', () => {
    expect(buildMentionChips(members, ['u1', 'u1', '', null]).map((chip) => chip.userId)).toEqual([
      'u1',
    ]);
    expect(buildMentionChips(null, ['u1'])).toHaveLength(1);
  });
});

describe('insertMentionDraft', () => {
  it('appends a spaced token to an empty or non-empty draft', () => {
    expect(insertMentionDraft('', 'Ada Lovelace')).toBe('@Ada Lovelace ');
    expect(insertMentionDraft('Looks good', 'Ada')).toBe('Looks good @Ada ');
    expect(insertMentionDraft('Looks good ', 'Ada')).toBe('Looks good @Ada ');
  });

  it('does not add the same token twice and ignores blank names', () => {
    expect(insertMentionDraft('Thanks @Ada ', 'Ada')).toBe('Thanks @Ada ');
    expect(insertMentionDraft('hi', '   ')).toBe('hi');
    expect(insertMentionDraft(null, 'Ada')).toBe('@Ada ');
  });
});

describe('splitMentionSegments', () => {
  it('splits text and known mentions, preferring the longest name', () => {
    const body = 'Hey @Grace Hopper, can you check dev@ada.com? @Ada Lovelace too.';
    const segments = splitMentionSegments(body, ['Ada', 'Ada Lovelace', 'Grace Hopper']);
    expect(segments).toEqual([
      { type: 'text', text: 'Hey ' },
      { type: 'mention', text: '@Grace Hopper', name: 'Grace Hopper' },
      { type: 'text', text: ', can you check dev@ada.com? ' },
      { type: 'mention', text: '@Ada Lovelace', name: 'Ada Lovelace' },
      { type: 'text', text: ' too.' },
    ]);
  });

  it('matches case-insensitively and at word boundaries only', () => {
    expect(splitMentionSegments('@ada hi', ['Ada'])).toEqual([
      { type: 'mention', text: '@ada', name: 'Ada' },
      { type: 'text', text: ' hi' },
    ]);
    expect(splitMentionSegments('mail me at dev@ada', ['Ada'])).toEqual([
      { type: 'text', text: 'mail me at dev@ada' },
    ]);
    expect(splitMentionSegments('@Adam hi', ['Ada'])).toEqual([{ type: 'text', text: '@Adam hi' }]);
    expect(splitMentionSegments('hi @@Ada', ['Ada'])).toEqual([{ type: 'text', text: 'hi @@Ada' }]);
  });

  it('returns whole text when no names are known and nothing for empty bodies', () => {
    expect(splitMentionSegments('plain text', [])).toEqual([{ type: 'text', text: 'plain text' }]);
    expect(splitMentionSegments('', ['Ada'])).toEqual([]);
    expect(splitMentionSegments(null, ['Ada'])).toEqual([]);
  });

  it('accepts mention objects and deduplicates names', () => {
    expect(mentionNames([{ name: 'Ada' }, { name: 'ada' }, { userId: 'u2' }, 'Grace'])).toEqual([
      'Ada',
      'Grace',
    ]);
    expect(splitMentionSegments('@Ada', [{ name: 'Ada' }])[0]).toMatchObject({
      type: 'mention',
      name: 'Ada',
    });
  });

  it('escapes regular-expression characters in names', () => {
    expect(splitMentionSegments('hi @A.B', ['A.B'])[1]).toMatchObject({
      type: 'mention',
      name: 'A.B',
    });
  });
});

describe('comment mentions', () => {
  const withMentions = comment('m1', '2026-10-30T10:00:00Z', {
    authorName: 'Ada Lovelace',
    mentions: [
      { userId: 'u2', name: 'Grace Hopper' },
      { userId: 'u2', name: 'Grace Hopper' },
      { userId: 'u3' },
    ],
  });

  it('normalises and deduplicates the mentions array', () => {
    expect(commentMentions(withMentions)).toEqual([
      { userId: 'u2', name: 'Grace Hopper' },
      { userId: 'u3', name: '' },
    ]);
    expect(commentMentions({ mentions: 'nope' })).toEqual([]);
    expect(commentMentions(null)).toEqual([]);
  });

  it('detects whether a user is mentioned', () => {
    expect(mentionsUser(withMentions, 'u2')).toBe(true);
    expect(mentionsUser(withMentions, 'u1')).toBe(false);
    expect(mentionsUser(withMentions, null)).toBe(false);
  });

  it('labels the badge for the list', () => {
    expect(mentionBadgeLabel(comment('plain', NOW), 'u1')).toBe('');
    expect(mentionBadgeLabel(withMentions, 'u2')).toBe('Mentions you');
    expect(mentionBadgeLabel(withMentions, 'u1')).toBe('2 mentions');
    expect(mentionBadgeLabel(comment('one', NOW, { mentions: [{ userId: 'u2', name: 'G' }] }), 'u1')).toBe(
      '1 mention'
    );
  });

  it('prefers authorName, then the member list, then a short id', () => {
    expect(authorDisplayName(withMentions)).toBe('Ada Lovelace');
    expect(
      authorDisplayName(comment('a', NOW, { userId: 'u2', authorName: '' }), [
        { userId: 'u2', name: 'Grace Hopper' },
      ])
    ).toBe('Grace Hopper');
    expect(
      authorDisplayName(comment('a', NOW, { userId: 'u3', authorName: '' }), [
        { userId: 'u3', email: 'linus@relay.test' },
      ])
    ).toBe('linus@relay.test');
    expect(authorDisplayName({ userId: 'user_0123456789' })).toBe('user_012');
  });
});

describe('mentions feed pages', () => {
  it('normalises the mentions envelope like a comments page', () => {
    const payload = {
      comments: [
        comment('a', '2026-10-30T09:00:00Z', { mentions: [{ userId: 'u1', name: 'Me' }] }),
        comment('b', '2026-10-30T11:00:00Z'),
      ],
      nextBefore: 'cmt_a',
    };
    expect(normalizeMentionsPayload(payload)).toEqual(normalizeCommentsPayload(payload));
  });

  it('merges pages newest first and deduplicates by id', () => {
    const merged = mergeMentionPages(
      { comments: [comment('a', '2026-10-30T09:00:00Z')], nextBefore: 'cmt_a' },
      {
        comments: [comment('a', '2026-10-30T09:00:00Z', { body: 'updated' }), comment('b', NOW)],
        nextBefore: 'cmt_b',
      }
    );
    expect(merged.comments.map((entry) => entry.id)).toEqual(['b', 'a']);
    expect(merged.comments[1].body).toBe('updated');
    expect(merged.nextBefore).toBe('cmt_b');
  });

  it('keeps the previous cursor when the page omits one and clears it on null', () => {
    expect(
      mergeMentionPages({ comments: [], nextBefore: 'cmt_a' }, { comments: [] }).nextBefore
    ).toBe('cmt_a');
    expect(
      mergeMentionPages({ comments: [], nextBefore: 'cmt_a' }, { comments: [], nextBefore: null })
        .nextBefore
    ).toBe(null);
  });

  it('tolerates missing pages', () => {
    expect(mergeMentionPages(null, null)).toEqual({ comments: [], nextBefore: null });
    expect(mergeMentionPages(undefined, { comments: [comment('x', NOW)] }).comments).toHaveLength(1);
  });
});
