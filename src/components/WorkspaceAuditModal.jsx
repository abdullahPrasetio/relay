import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import {
  formatAuditAction,
  formatAuditTarget,
  formatAuditTimestamp,
  mergeAuditEvents,
  shortId,
} from './teamUi.js';

const PAGE_SIZE = 30;

function errorMessage(res, fallback) {
  return res?.error?.message || fallback;
}

// Audit trail for a linked workspace, newest first. Pagination follows the
// API's `nextBefore` cursor; events are merged/deduplicated so a stale cursor
// can never duplicate a row.
export default function WorkspaceAuditModal({
  workspace,
  cloud: cloudBridge = null,
  onClose,
}) {
  const api = useMemo(
    () => cloudBridge || (typeof window !== 'undefined' ? window.api?.cloud : null),
    [cloudBridge]
  );
  const remoteId = workspace?.cloud?.remoteId || null;

  const [events, setEvents] = useState([]);
  const [nextBefore, setNextBefore] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const requestSeq = useRef(0);

  const fetchPage = useCallback(
    async (before, { append } = { append: false }) => {
      const seq = ++requestSeq.current;
      if (!remoteId) {
        setLoading(false);
        setLoadingMore(false);
        setError('This workspace is not linked to Relay Cloud.');
        return;
      }
      if (!api || typeof api.listAudit !== 'function') {
        setLoading(false);
        setLoadingMore(false);
        setError('The audit log requires the desktop app.');
        return;
      }
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError('');
      try {
        const res = await api.listAudit({
          workspaceId: remoteId,
          before: before ?? undefined,
          limit: PAGE_SIZE,
        });
        if (seq !== requestSeq.current) return;
        if (!res?.ok) {
          if (!append) setEvents([]);
          setError(errorMessage(res, 'Could not load the audit log.'));
          return;
        }
        const page = res.data || {};
        setEvents((previous) =>
          append ? mergeAuditEvents(previous, page.events) : mergeAuditEvents([], page.events)
        );
        setNextBefore(page.nextBefore ?? null);
      } catch (err) {
        if (seq !== requestSeq.current) return;
        if (!append) setEvents([]);
        setError(err?.message || 'Could not load the audit log.');
      } finally {
        if (seq === requestSeq.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [api, remoteId]
  );

  useEffect(() => {
    fetchPage(null, { append: false });
  }, [fetchPage]);

  return (
    <Modal
      title={`Audit log · ${workspace?.name || 'Workspace'}`}
      onClose={onClose}
      width={620}
      footer={
        <button type="button" className="mini-btn" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="team-modal team-audit" data-testid="workspace-audit-modal">
        {error && (
          <div className="cloud-error team-error" role="alert">
            {error}
          </div>
        )}

        {loading ? (
          <div className="team-empty">Loading audit events…</div>
        ) : events.length === 0 ? (
          <div className="team-empty">
            {error ? 'No events to show.' : 'No audit events yet.'}
          </div>
        ) : (
          <ol className="team-audit-list">
            {events.map((event) => (
              <li key={event.id} className="team-audit-event">
                <div className="team-audit-main">
                  <span className="team-audit-action" title={event.action}>
                    {formatAuditAction(event.action)}
                  </span>
                  <span className="team-audit-target">{formatAuditTarget(event.target)}</span>
                </div>
                <div className="team-audit-meta">
                  <code title={event.actorId || ''}>
                    {shortId(event.actorId) || 'system'}
                  </code>
                  <span title={event.createdAt ? String(event.createdAt) : ''}>
                    {formatAuditTimestamp(event.createdAt)}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        )}

        {!loading && (nextBefore || loadingMore) && (
          <div className="team-audit-more">
            <button
              type="button"
              className="mini-btn"
              onClick={() => fetchPage(nextBefore, { append: true })}
              disabled={loadingMore}
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
