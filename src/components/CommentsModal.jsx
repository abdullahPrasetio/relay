import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import Icon from './Icon.jsx';
import { useDialogs } from './Dialogs.jsx';
import {
  COMMENT_MAX_LENGTH,
  authorDisplayName,
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
  normalizeCommentsPayload,
  resolveActionLabel,
  resolveLabel,
  splitMentionSegments,
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
  const [members, setMembers] = useState([]);
  const [mentionError, setMentionError] = useState('');
  const [mentionOpen, setMentionOpen] = useState(false);
  const [selectedMentions, setSelectedMentions] = useState([]);
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

  // Mention picker data. A failure here never blocks reading or posting a
  // comment: the composer simply offers no names and says why.
  useEffect(() => {
    if (!remoteId || !api || typeof api.members !== 'function') {
      setMembers([]);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await api.members({ workspaceId: remoteId });
        if (cancelled) return;
        if (!res?.ok) {
          setMembers([]);
          setMentionError(errorMessage(res, 'Could not load workspace members.'));
          return;
        }
        setMembers(Array.isArray(res.data) ? res.data : []);
        setMentionError('');
      } catch (err) {
        if (!cancelled) {
          setMembers([]);
          setMentionError(err?.message || 'Could not load workspace members.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, remoteId]);

  const options = useMemo(
    () => mentionOptions(members, currentUserId),
    [members, currentUserId]
  );
  const chips = useMemo(
    () => buildMentionChips(members, selectedMentions),
    [members, selectedMentions]
  );
  const knownNames = useMemo(() => mentionNames(members), [members]);

  function toggleMention(option) {
    if (selectedMentions.includes(option.userId)) {
      setSelectedMentions((prev) => prev.filter((id) => id !== option.userId));
      return;
    }
    setSelectedMentions((prev) =>
      prev.includes(option.userId) ? prev : [...prev, option.userId]
    );
    // Selecting inserts an editable token; removing a chip leaves the text
    // alone so the author can fix the sentence themselves.
    setDraft((prev) => insertMentionDraft(prev, option.name || option.label));
  }

  function removeMention(chip) {
    setSelectedMentions((prev) => prev.filter((id) => id !== chip.userId));
  }

  function bodySegments(entry) {
    const names = [...commentMentions(entry).map((mention) => mention.name), ...knownNames];
    return splitMentionSegments(entry.body, names);
  }

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
      const mentions = selectedMentions.length ? selectedMentions : undefined;
      const res = await api.createComment(remoteId, { entityId, body: check.value, mentions });
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
        setSelectedMentions([]);
        await load();
        return;
      }
      setComments((prev) => mergeComments(prev, [created]));
      setDraft('');
      setSelectedMentions([]);
      setMentionOpen(false);
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
                  const badge = mentionBadgeLabel(entry, currentUserId);
                  return (
                    <li
                      key={entry.id || `${entry.createdAt}-${entry.body}`}
                      className={`comment-item ${resolved ? 'resolved' : ''}`}
                      data-testid="comment-item"
                    >
                      <div className="comment-head">
                        <code className="comment-author" title={entry.userId || ''}>
                          {authorDisplayName(entry, members)}
                        </code>
                        <span
                          className="comment-time"
                          title={commentDateTime(entry.createdAt) || ''}
                        >
                          {commentTime(entry.createdAt)}
                        </span>
                        {badge && (
                          <span
                            className={`comment-mention-badge ${
                              mentionsUser(entry, currentUserId) ? 'you' : ''
                            }`}
                            data-testid="comment-mention-badge"
                          >
                            {badge}
                          </span>
                        )}
                        <span
                          className={`comment-state ${resolved ? 'resolved' : 'open'}`}
                          data-testid="comment-state"
                        >
                          {resolveLabel(entry)}
                        </span>
                      </div>
                      <p className="comment-body">
                        {bodySegments(entry).map((segment, index) =>
                          segment.type === 'mention' ? (
                            <span
                              key={`mention-${index}`}
                              className="comment-mention"
                              data-testid="comment-mention-token"
                            >
                              {segment.text}
                            </span>
                          ) : (
                            <React.Fragment key={`text-${index}`}>{segment.text}</React.Fragment>
                          )
                        )}
                      </p>
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
              <div className="comment-tools">
                <button
                  type="button"
                  className={`mini-btn comment-mention-toggle ${mentionOpen ? 'open' : ''}`}
                  onClick={() => setMentionOpen((value) => !value)}
                  aria-expanded={mentionOpen}
                  aria-haspopup="true"
                  disabled={posting}
                  data-testid="comment-mention-toggle"
                >
                  <Icon name="comment" size={12} />
                  <span>
                    {selectedMentions.length
                      ? `Mentions (${selectedMentions.length})`
                      : 'Mention'}
                  </span>
                </button>
                <span className="comment-hint">@ mentions notify workspace members</span>
              </div>

              {mentionOpen && (
                <div className="mention-picker" data-testid="comment-mention-picker">
                  {mentionError ? (
                    <div className="mention-note" data-testid="comment-mention-error">
                      {mentionError}
                    </div>
                  ) : options.length === 0 ? (
                    <div className="mention-note">No other workspace members to mention.</div>
                  ) : (
                    <ul className="mention-options">
                      {options.map((option) => {
                        const checked = selectedMentions.includes(option.userId);
                        return (
                          <li key={option.userId}>
                            <label className="mention-option">
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={posting}
                                onChange={() => toggleMention(option)}
                                data-testid={`comment-mention-option-${option.userId}`}
                              />
                              <span className="mention-option-name">
                                {option.name || option.email || option.label}
                              </span>
                              {option.name && option.email && (
                                <span className="mention-option-email">{option.email}</span>
                              )}
                              {option.role && (
                                <span className="mention-option-role">{option.role}</span>
                              )}
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}

              {chips.length > 0 && (
                <div className="mention-chips" data-testid="comment-mention-chips">
                  {chips.map((chip) => (
                    <span
                      key={chip.userId}
                      className="mention-chip"
                      data-testid={`comment-mention-chip-${chip.userId}`}
                    >
                      @{chip.name || chip.label}
                      <button
                        type="button"
                        className="mention-chip-remove"
                        onClick={() => removeMention(chip)}
                        title={`Remove mention ${chip.name || chip.label}`}
                        aria-label={`Remove mention ${chip.name || chip.label}`}
                        disabled={posting}
                      >
                        <Icon name="close" size={10} />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <textarea
                className="comment-input"
                rows={3}
                value={draft}
                maxLength={COMMENT_MAX_LENGTH}
                placeholder="Write a comment… Use @Name to mention a teammate."
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
