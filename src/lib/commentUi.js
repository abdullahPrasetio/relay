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
