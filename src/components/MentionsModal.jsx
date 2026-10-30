import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import {
  authorDisplayName,
  commentDateTime,
  commentMentions,
  commentTime,
  hasMoreComments,
  mentionNames,
  mergeMentionPages,
  normalizeMentionsPayload,
  splitMentionSegments,
} from '../lib/commentUi.js';

const PAGE_SIZE = 30;

function errorMessage(res, fallback) {
  return res?.error?.message || fallback;
}

// Workspace-wide feed of comments that mention the signed-in user. The caller
// is resolved from the session in the main process, so this modal never sends
// a user id and never sees cloud credentials.
export default function MentionsModal({
  workspace,
  cloud: cloudBridge = null,
  onClose,
}) {
  const api = useMemo(
    () => cloudBridge || (typeof window !== 'undefined' ? window.api?.cloud : null),
    [cloudBridge]
  );
  const remoteId = workspace?.cloud?.remoteId || null;
  const workspaceName =
    typeof workspace?.name === 'string' && workspace.name.trim()
      ? workspace.name.trim()
      : 'Workspace';

  const [comments, setComments] = useState([]);
  const [nextBefore, setNextBefore] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
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
    if (!api || typeof api.mentions !== 'function') {
      setComments([]);
      setNextBefore(null);
      setLoading(false);
      setError('Mentions require the desktop app.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await api.mentions(remoteId, { limit: PAGE_SIZE });
      if (seq !== requestSeq.current) return;
      if (!res?.ok) {
        setComments([]);
        setNextBefore(null);
        setError(errorMessage(res, 'Could not load mentions.'));
        return;
      }
      const page = normalizeMentionsPayload(res.data);
      setComments(page.comments);
      setNextBefore(page.nextBefore);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setComments([]);
      setNextBefore(null);
      setError(err?.message || 'Could not load mentions.');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [api, remoteId]);

  useEffect(() => {
    load();
  }, [load]);

  async function loadMore() {
    if (!nextBefore || loadingMore || !api || typeof api.mentions !== 'function') return;
    setLoadingMore(true);
    setError('');
    try {
      const res = await api.mentions(remoteId, { before: nextBefore, limit: PAGE_SIZE });
      if (!res?.ok) {
        setError(errorMessage(res, 'Could not load more mentions.'));
        return;
      }
      const page = normalizeMentionsPayload(res.data);
      const merged = mergeMentionPages(
        { comments, nextBefore },
        { comments: page.comments, nextBefore: page.nextBefore }
      );
      setComments(merged.comments);
      setNextBefore(merged.nextBefore);
    } catch (err) {
      setError(err?.message || 'Could not load more mentions.');
    } finally {
      setLoadingMore(false);
    }
  }

  const countLabel =
    comments.length === 0
      ? 'No mentions'
      : comments.length === 1
        ? '1 mention'
        : `${comments.length} mentions`;

  return (
    <Modal
      title={`Mentions · ${workspaceName}`}
      onClose={onClose}
      width={640}
      footer={
        <button type="button" className="mini-btn" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="mentions-modal" data-testid="mentions-modal">
        <div className="mentions-heading">
          <div className="mentions-intro">
            Comments that mention you across this workspace, newest first.
          </div>
          <span className="comments-count" data-testid="mentions-count">
            {countLabel}
          </span>
        </div>

        {error && (
          <div className="cloud-error team-error" role="alert" data-testid="mentions-error">
            {error}
          </div>
        )}

        {loading ? (
          <div className="team-empty">Loading mentions…</div>
        ) : comments.length === 0 ? (
          error ? null : (
            <div className="team-empty" data-testid="mentions-empty">
              No mentions yet. When a teammate @mentions you, the comment shows up here.
            </div>
          )
        ) : (
          <ul className="mention-feed" data-testid="mention-list">
            {comments.map((entry) => {
              const names = mentionNames(commentMentions(entry));
              const segments = splitMentionSegments(entry.body, names);
              const author = authorDisplayName(entry, null);
              return (
                <li
                  key={entry.id || `${entry.entityId}-${entry.createdAt}-${entry.body}`}
                  className="mention-feed-item"
                  data-testid="mention-item"
                >
                  <div className="mention-feed-head">
                    <code
                      className="mention-feed-entity"
                      title={entry.entityId || ''}
                      data-testid="mention-entity"
                    >
                      {entry.entityId || 'unknown entity'}
                    </code>
                    <code className="comment-author" title={entry.userId || ''}>
                      {author}
                    </code>
                    <span
                      className="comment-time"
                      title={commentDateTime(entry.createdAt) || ''}
                    >
                      {commentTime(entry.createdAt)}
                    </span>
                  </div>
                  <p className="comment-body">
                    {segments.map((segment, index) =>
                      segment.type === 'mention' ? (
                        <span
                          key={`mention-${index}`}
                          className="comment-mention"
                          data-testid="mention-token"
                        >
                          {segment.text}
                        </span>
                      ) : (
                        <React.Fragment key={`text-${index}`}>{segment.text}</React.Fragment>
                      )
                    )}
                  </p>
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
              data-testid="mentions-load-more"
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
