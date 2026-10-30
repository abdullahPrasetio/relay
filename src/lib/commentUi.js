// Pure helpers for the per-request comments UI. Kept free of React and of the
// cloud bridge so ordering, cursors, and composer validation stay unit
// testable without Electron.

import { formatDateTime, formatRelativeTime } from './deviceUi.js';

export const COMMENT_MAX_LENGTH = 4000;

/**
 * Trim an opaque author id for display without leaking a long uuid. Empty
 * values yield '' so callers can pick their own placeholder.
 */
export function authorShortId(value, length = 8) {
  if (value === undefined || value === null) return '';
  const id = String(value).trim();
  if (!id) return '';
  return id.length <= length ? id : id.slice(0, length);
}

/** Author label for the comment list; stable placeholder for missing ids. */
export function authorLabel(value, length = 8) {
  return authorShortId(value, length) || 'Unknown author';
}

/** Compact relative time for a comment timestamp; '' when unparseable. */
export function commentTime(value, now = Date.now()) {
  return formatRelativeTime(value, now);
}

/** Absolute timestamp for the hover title. */
export function commentDateTime(value) {
  return formatDateTime(value);
}

function timestampOf(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) return new Date(value).getTime();
  return NaN;
}

function commentCreatedAt(comment) {
  return comment?.createdAt ?? comment?.created_at ?? null;
}

/** True when the comment carries a resolution marker. */
export function isResolved(comment) {
  if (typeof comment === 'boolean') return comment;
  if (!comment || typeof comment !== 'object') return false;
  if (comment.resolvedAt !== undefined && comment.resolvedAt !== null) {
    return Boolean(comment.resolvedAt);
  }
  if (comment.resolved_at !== undefined && comment.resolved_at !== null) {
    return Boolean(comment.resolved_at);
  }
  return Boolean(comment.resolved);
}

/** Badge label for a comment (or a bare resolved flag). */
export function resolveLabel(comment) {
  return isResolved(comment) ? 'Resolved' : 'Open';
}

/** Button label that performs the opposite of the current state. */
export function resolveActionLabel(comment) {
  return isResolved(comment) ? 'Unresolve' : 'Resolve';
}

/**
 * Newest first by creation time. Entries without a usable timestamp keep
 * their input order after dated ones; the sort is stable and never mutates
 * the input.
 */
export function sortCommentsNewestFirst(comments) {
  const list = Array.isArray(comments) ? comments : [];
  return list
    .map((comment, index) => ({ comment, index, time: timestampOf(commentCreatedAt(comment)) }))
    .sort((a, b) => {
      const aTime = Number.isFinite(a.time) ? a.time : -Infinity;
      const bTime = Number.isFinite(b.time) ? b.time : -Infinity;
      if (aTime !== bTime) return bTime - aTime;
      return a.index - b.index;
    })
    .map((entry) => entry.comment);
}

/** Deduplicate by id, keeping the last copy, then order newest first. */
export function mergeComments(existing, incoming) {
  const byKey = new Map();
  const anonymous = [];
  for (const comment of [...(existing || []), ...(incoming || [])]) {
    if (!comment || typeof comment !== 'object') continue;
    if (comment.id === undefined || comment.id === null || comment.id === '') {
      anonymous.push(comment);
      continue;
    }
    byKey.set(String(comment.id), comment);
  }
  return sortCommentsNewestFirst([...byKey.values(), ...anonymous]);
}

/**
 * Cursor from a comments response. `before` is a comment id, but the series
 * is opaque here; anything non-empty is passed back verbatim.
 */
export function normalizeNextBefore(payload) {
  const value = payload?.nextBefore ?? payload?.next_before ?? null;
  if (value === undefined || value === null) return null;
  const cursor = String(value).trim();
  return cursor || null;
}

/** Whether a response says another page is available. */
export function hasMoreComments(payload) {
  return normalizeNextBefore(payload) !== null;
}

/**
 * Normalise a comments page. Accepts the API payload (`{comments,nextBefore}`),
 * a bare array, and snake_case cursors so the modal works against older
 * bridges too.
 */
export function normalizeCommentsPayload(payload) {
  const list = Array.isArray(payload) ? payload : payload?.comments;
  return {
    comments: mergeComments([], Array.isArray(list) ? list : []),
    nextBefore: normalizeNextBefore(payload),
  };
}

/** "No comments" / "1 comment" / "4 comments". */
export function commentCountLabel(value) {
  const count = Array.isArray(value)
    ? value.length
    : Math.max(0, Math.trunc(Number(value) || 0));
  if (count === 0) return 'No comments';
  return count === 1 ? '1 comment' : `${count} comments`;
}

/**
 * Validate the composer text: trimmed, non-empty, at most `maxLength`. The
 * returned `value` is the text that should be sent.
 */
export function validateCommentBody(value, { maxLength = COMMENT_MAX_LENGTH } = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    return { ok: false, value: '', error: 'Write a comment before posting.' };
  }
  if (text.length > maxLength) {
    return { ok: false, value: text, error: `Comments are limited to ${maxLength} characters.` };
  }
  return { ok: true, value: text, error: '' };
}

/**
 * Whether the caller may resolve or delete a comment. The server enforces
 * authorship for non-admins; when either identity is unknown the controls
 * stay visible so a role error is not hidden behind a missing id.
 */
export function canModifyComment(comment, currentUserId) {
  const author = comment?.userId ?? comment?.user_id ?? null;
  if (!author || !currentUserId) return true;
  return String(author) === String(currentUserId);
}

// --- @mentions -----------------------------------------------------------

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function memberId(member) {
  const raw = member?.userId ?? member?.user_id ?? null;
  return raw === undefined || raw === null ? '' : String(raw).trim();
}

/** Display name from a member/mention payload: name, then email, then id. */
export function memberName(entry) {
  if (typeof entry === 'string') return entry.trim();
  const name = cleanText(entry?.name);
  if (name) return name;
  const email = cleanText(entry?.email);
  if (email) return email;
  return authorShortId(memberId(entry));
}

/** Hub for the mention picker: workspace members minus the caller, deduped. */
export function mentionOptions(members, currentUserId = null) {
  const list = Array.isArray(members) ? members : [];
  const selfId = currentUserId === undefined || currentUserId === null ? '' : String(currentUserId);
  const seen = new Set();
  const options = [];
  for (const member of list) {
    if (!member || typeof member !== 'object') continue;
    const userId = memberId(member);
    if (!userId || userId === selfId || seen.has(userId)) continue;
    seen.add(userId);
    const name = cleanText(member.name);
    const email = cleanText(member.email);
    options.push({
      userId,
      name,
      email,
      role: member.role ?? null,
      label: name || email || authorShortId(userId) || 'Member',
    });
  }
  return options.sort((a, b) => {
    const left = a.label.toLowerCase();
    const right = b.label.toLowerCase();
    if (left === right) return a.userId.localeCompare(b.userId);
    return left < right ? -1 : 1;
  });
}

/**
 * Chips for the selected mention ids, in selection order. Unknown ids (for
 * example a member removed after being selected) keep a stable short label
 * instead of disappearing from the composer.
 */
export function buildMentionChips(entries, ids) {
  const byId = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const id = memberId(entry);
    if (id && !byId.has(id)) byId.set(id, entry);
  }
  const seen = new Set();
  const chips = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    const userId = raw === undefined || raw === null ? '' : String(raw).trim();
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    const entry = byId.get(userId);
    const name = memberName(entry) || '';
    const email = cleanText(entry?.email);
    chips.push({
      userId,
      name,
      email,
      label: name || email || authorShortId(userId) || 'Member',
    });
  }
  return chips;
}

/**
 * Append an editable `@Name` token to the draft when a member is selected.
 * Existing text is preserved; the token is separated by a single space and a
 * trailing space keeps typing natural. Duplicate tokens are not added.
 */
export function insertMentionDraft(draft, name) {
  const text = typeof draft === 'string' ? draft : '';
  const label = cleanText(name);
  if (!label) return text;
  if (text.includes(`@${label}`)) return text;
  if (!text) return `@${label} `;
  const separator = /\s$/.test(text) ? '' : ' ';
  return `${text}${separator}@${label} `;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Known display names from comment.mentions or member records, deduped. */
export function mentionNames(entries) {
  const seen = new Set();
  const names = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const name = typeof entry === 'string' ? cleanText(entry) : cleanText(entry?.name);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

/**
 * Split a body into `{type:'text'|'mention'}` segments for the known names.
 * Names match case-insensitively at a word boundary, longest name first, so
 * `@Ada Lovelace` wins over `@Ada` and `dev@ada` is never a mention.
 */
export function splitMentionSegments(body, names) {
  const text = typeof body === 'string' ? body : '';
  if (!text) return [];
  const canonical = new Map();
  for (const name of mentionNames(names)) {
    const key = name.toLowerCase();
    if (!canonical.has(key)) canonical.set(key, name);
  }
  if (canonical.size === 0) return [{ type: 'text', text }];

  const alternation = [...canonical.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  const pattern = new RegExp(`@(${alternation})(?![\\p{L}\\p{N}_])`, 'giu');

  const segments = [];
  let cursor = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    const previous = start > 0 ? text[start - 1] : '';
    if (previous && /[\p{L}\p{N}_@]/u.test(previous)) continue;
    if (start > cursor) segments.push({ type: 'text', text: text.slice(cursor, start) });
    const name = canonical.get(match[1].toLowerCase()) || match[1];
    segments.push({ type: 'mention', text: match[0], name });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) segments.push({ type: 'text', text: text.slice(cursor) });
  return segments.length ? segments : [{ type: 'text', text }];
}

/** Normalised mentions array from a comment payload. */
export function commentMentions(comment) {
  const list = Array.isArray(comment?.mentions) ? comment.mentions : [];
  const seen = new Set();
  const mentions = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const userId = memberId(entry);
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    mentions.push({ userId, name: cleanText(entry.name) });
  }
  return mentions;
}

/** True when the comment mentions the given user. */
export function mentionsUser(comment, userId) {
  if (!userId) return false;
  const target = String(userId);
  return commentMentions(comment).some((entry) => entry.userId === target);
}

/** Compact badge for a comment: '' (none), 'Mentions you', '1 mention', ... */
export function mentionBadgeLabel(comment, currentUserId = null) {
  const mentions = commentMentions(comment);
  if (mentions.length === 0) return '';
  if (currentUserId && mentionsUser(comment, currentUserId)) return 'Mentions you';
  return mentions.length === 1 ? '1 mention' : `${mentions.length} mentions`;
}

/** Author name from the payload, falling back to the member list and then id. */
export function authorDisplayName(comment, members = null) {
  const direct = cleanText(comment?.authorName ?? comment?.author_name);
  if (direct) return direct;
  const authorId = comment?.userId ?? comment?.user_id ?? null;
  if (authorId !== null && authorId !== undefined) {
    const member = (Array.isArray(members) ? members : []).find(
      (entry) => memberId(entry) === String(authorId)
    );
    const named = memberName(member);
    if (named) return named;
  }
  return authorLabel(authorId);
}

/** Whether a mentions page says another page is available. */
export function normalizeMentionsPayload(payload) {
  return normalizeCommentsPayload(payload);
}

/**
 * Merge a mentions page into the accumulated feed. `incoming.nextBefore`
 * always wins when the property is present (including null, which ends the
 * feed); otherwise the previous cursor is kept.
 */
export function mergeMentionPages(existing, incoming) {
  const previous = existing && typeof existing === 'object' ? existing : {};
  const next = incoming && typeof incoming === 'object' ? incoming : {};
  const hasCursor =
    Object.prototype.hasOwnProperty.call(next, 'nextBefore') ||
    Object.prototype.hasOwnProperty.call(next, 'next_before');
  const nextBefore = hasCursor
    ? normalizeNextBefore(next)
    : normalizeNextBefore(previous);
  return {
    comments: mergeComments(
      Array.isArray(previous.comments) ? previous.comments : [],
      Array.isArray(next.comments) ? next.comments : []
    ),
    nextBefore,
  };
}
