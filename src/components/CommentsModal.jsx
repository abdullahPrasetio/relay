import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import Icon from './Icon.jsx';
import { useDialogs } from './Dialogs.jsx';
import {
  COMMENT_MAX_LENGTH,
  authorLabel,
  canModifyComment,
  commentCountLabel,
  commentDateTime,
  commentTime,
  hasMoreComments,
  isResolved,
  mergeComments,
  normalizeCommentsPayload,
  resolveActionLabel,
  resolveLabel,
  validateCommentBody,
} from '../lib/commentUi.js';

function errorMessage(res, fallback) {
  return res?.error?.message || fallback;
}

// Per-request discussion thread for the active request. Only the remote
// workspace id and the request id are sent to the main-process bridge; the
// component never sees cloud credentials.
export default function CommentsModal({
  workspace,
  request,
  currentUserId = null,
  cloud: cloudBridge = null,
  onClose,
}) {
  const dialogs = useDialogs();
  const api = useMemo(
    () => cloudBridge || (typeof window !== 'undefined' ? window.api?.cloud : null),
    [cloudBridge]
  );
  const remoteId = workspace?.cloud?.remoteId || null;
  const entityId = request?.id ? String(request.id) : null;
  const requestName =
    typeof request?.name === 'string' && request.name.trim() ? request.name.trim() : 'Untitled Request';

  const [comments, setComments] = useState([]);
  const [nextBefore, setNextBefore] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [validation, setValidation] = useState('');
  const [posting, setPosting] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    if (!remoteId) {
      setComments([]);
      setNextBefore(null);
      setLoading(false);
      setError('This workspace is not linked to Relay Cloud.');
      return;
    }
    if (!entityId) {
      setComments([]);
      setNextBefore(null);
      setLoading(false);
      setError('Save this request to the workspace before adding comments.');
      return;
    }
    if (!api || typeof api.comments !== 'function') {
      setComments([]);
      setNextBefore(null);
      setLoading(false);
      setError('Comments require the desktop app.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await api.comments(remoteId, { entityId });
      if (seq !== requestSeq.current) return;
      if (!res?.ok) {
        setComments([]);
        setNextBefore(null);
        setError(errorMessage(res, 'Could not load comments.'));
        return;
      }
      const page = normalizeCommentsPayload(res.data);
      setComments(page.comments);
      setNextBefore(page.nextBefore);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setComments([]);
      setNextBefore(null);
      setError(err?.message || 'Could not load comments.');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [api, entityId, remoteId]);

  useEffect(() => {
    load();
  }, [load]);

  async function loadMore() {
    if (!nextBefore || loadingMore || !api || typeof api.comments !== 'function') return;
    setLoadingMore(true);
    setError('');
    try {
      const res = await api.comments(remoteId, { entityId, before: nextBefore });
      if (!res?.ok) {
        setError(errorMessage(res, 'Could not load more comments.'));
        return;
      }
      const page = normalizeCommentsPayload(res.data);
      setComments((prev) => mergeComments(prev, page.comments));
      setNextBefore(page.nextBefore ?? null);
    } catch (err) {
      setError(err?.message || 'Could not load more comments.');
    } finally {
      setLoadingMore(false);
    }
  }

  async function post(event) {
    event?.preventDefault?.();
    if (posting) return;
    const check = validateCommentBody(draft);
    if (!check.ok) {
      setValidation(check.error);
      return;
    }
    if (!api || typeof api.createComment !== 'function') {
      setValidation('Comments require the desktop app.');
      return;
    }
    setPosting(true);
    setValidation('');
    setError('');
    try {
      const res = await api.createComment(remoteId, { entityId, body: check.value });
      if (!res?.ok) {
        setValidation(errorMessage(res, 'Could not post this comment.'));
        return;
      }
      const created =
        res.data && typeof res.data === 'object' && res.data.id ? res.data : null;
      if (!created) {
        // A bridge without the created row still posted it; re-read the page
        // rather than inventing a row that cannot be resolved or deleted.
        setDraft('');
        await load();
        return;
      }
      setComments((prev) => mergeComments(prev, [created]));
      setDraft('');
    } catch (err) {
      setValidation(err?.message || 'Could not post this comment.');
    } finally {
      setPosting(false);
    }
  }

  async function toggleResolved(entry) {
    if (busyId || !api || typeof api.updateComment !== 'function') return;
    const resolved = !isResolved(entry);
    setBusyId(entry.id);
    setError('');
    try {
      const res = await api.updateComment(entry.id, { resolved });
      if (!res?.ok) {
        setError(errorMessage(res, 'Could not update this comment.'));
        return;
      }
      const updated = res.data && typeof res.data === 'object' ? res.data : {};
      setComments((prev) =>
        prev.map((comment) => {
          if (comment.id !== entry.id) return comment;
          const next = { ...comment, ...updated };
          // The server normally echoes resolvedAt; fall back to the requested
          // state so the badge never lies about the outcome.
          next.resolvedAt = resolved
            ? updated.resolvedAt ?? new Date().toISOString()
            : null;
          return next;
        })
      );
    } catch (err) {
      setError(err?.message || 'Could not update this comment.');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(entry) {
    if (busyId || !api || typeof api.deleteComment !== 'function') return;
    const ok = await dialogs.confirm('Delete this comment? This cannot be undone.', {
      title: 'Delete comment',
      okLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    setBusyId(entry.id);
    setError('');
    try {
      const res = await api.deleteComment(entry.id);
      if (!res?.ok) {
        setError(errorMessage(res, 'Could not delete this comment.'));
        return;
      }
      setComments((prev) => prev.filter((comment) => comment.id !== entry.id));
    } catch (err) {
      setError(err?.message || 'Could not delete this comment.');
    } finally {
      setBusyId(null);
    }
  }

  const linked = Boolean(remoteId);
  const count = commentCountLabel(comments);

  return (
    <Modal title={`Comments — ${requestName}`} onClose={onClose} width={620}>
      <div className="comments-modal" data-testid="comments-modal">
        <div className="comments-heading">
          <div className="comments-request">
            <span className="comments-request-label">Request</span>
            <strong data-testid="comments-request-name">{requestName}</strong>
          </div>
          <span className="comments-count" data-testid="comments-count">
            {count}
          </span>
        </div>

        {!linked && (
          <p className="comments-notice" data-testid="comments-unlinked">
            This workspace is not linked to Relay Cloud. Link it to comment on synced
            requests.
          </p>
        )}

        {linked && error && (
          <div className="cloud-error team-error" role="alert" data-testid="comments-error">
            {error}
          </div>
        )}

        {linked && (
          <>
            {loading ? (
              <div className="team-empty">Loading comments…</div>
            ) : comments.length === 0 ? (
              <div className="team-empty">No comments yet. Start the discussion.</div>
            ) : (
              <ul className="comment-list" data-testid="comment-list">
                {comments.map((entry) => {
                  const resolved = isResolved(entry);
                  const canModify = canModifyComment(entry, currentUserId);
                  const busy = busyId === entry.id;
                  return (
                    <li
                      key={entry.id || `${entry.createdAt}-${entry.body}`}
                      className={`comment-item ${resolved ? 'resolved' : ''}`}
                      data-testid="comment-item"
                    >
                      <div className="comment-head">
                        <code className="comment-author" title={entry.userId || ''}>
                          {authorLabel(entry.userId)}
                        </code>
                        <span
                          className="comment-time"
                          title={commentDateTime(entry.createdAt) || ''}
                        >
                          {commentTime(entry.createdAt)}
                        </span>
                        <span
                          className={`comment-state ${resolved ? 'resolved' : 'open'}`}
                          data-testid="comment-state"
                        >
                          {resolveLabel(entry)}
                        </span>
                      </div>
                      <p className="comment-body">{entry.body}</p>
                      {canModify && (
                        <div className="comment-actions">
                          <button
                            type="button"
                            className="mini-btn"
                            onClick={() => toggleResolved(entry)}
                            disabled={busy}
                            data-testid={`comment-resolve-${entry.id}`}
                          >
                            {resolveActionLabel(entry)}
                          </button>
                          <button
                            type="button"
                            className="mini-btn danger"
                            onClick={() => remove(entry)}
                            disabled={busy}
                            title="Delete comment"
                            data-testid={`comment-delete-${entry.id}`}
                          >
                            <Icon name="trash" size={13} />
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {!loading && hasMoreComments({ nextBefore }) && (
              <div className="comments-more">
                <button
                  type="button"
                  className="mini-btn"
                  onClick={loadMore}
                  disabled={loadingMore}
                  data-testid="comments-load-more"
                >
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}

            <form className="comment-composer" onSubmit={post}>
              <textarea
                className="comment-input"
                rows={3}
                value={draft}
                maxLength={COMMENT_MAX_LENGTH}
                placeholder="Write a comment…"
                onChange={(event) => {
                  setDraft(event.target.value);
                  if (validation) setValidation('');
                }}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    event.preventDefault();
                    post(event);
                  }
                }}
                disabled={posting}
                data-testid="comment-input"
              />
              <div className="comment-composer-foot">
                <span className="comment-hint">
                  {draft.trim().length}/{COMMENT_MAX_LENGTH}
                </span>
                <button
                  type="submit"
                  className="send-btn"
                  disabled={posting}
                  data-testid="comment-post"
                >
                  {posting ? 'Posting…' : 'Post'}
                </button>
              </div>
              {validation && (
                <div className="comment-validation" role="alert" data-testid="comment-validation">
                  {validation}
                </div>
              )}
            </form>
          </>
        )}
      </div>
    </Modal>
  );
}
