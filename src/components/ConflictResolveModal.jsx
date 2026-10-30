import React, { useState } from 'react';
import Modal from './Modal.jsx';
import { useDialogs } from './Dialogs.jsx';
import { conflictSummary, describeConflict, formatRelativeTime, shortId } from '../lib/deviceUi.js';

function errorMessage(res, fallback) {
  return res?.error?.message || fallback;
}

function conflictKey(conflict, index) {
  const opId = conflict?.opId != null ? String(conflict.opId) : '';
  const id = conflict?.id != null ? String(conflict.id) : '';
  return `${opId}:${id}:${index}`;
}

function idsOf(conflicts) {
  const ids = [];
  for (const conflict of conflicts) {
    if (conflict?.id == null) continue;
    const id = conflict.id;
    if (!ids.some((entry) => String(entry) === String(id))) ids.push(id);
  }
  return ids;
}

// Per-change resolution for sync conflicts. `resolve` is the optional
// controller method (ids, 'server' | 'local'); without it the modal still
// offers the legacy "keep local for all" replay.
export default function ConflictResolveModal({
  conflicts,
  onClose,
  resolve = null,
  dismiss = null,
}) {
  const dialogs = useDialogs();
  const list = Array.isArray(conflicts) ? conflicts : [];
  const [pending, setPending] = useState(null); // { ids, strategy }
  const [error, setError] = useState('');

  const canResolve = typeof resolve === 'function';
  const canKeepLocalAll = canResolve || typeof dismiss === 'function';
  const busy = !!pending;

  async function apply(ids, strategy) {
    if (busy || ids.length === 0) return;
    if (!canResolve) {
      setError('This Relay build cannot resolve conflicts individually. Update the app to choose a side.');
      return;
    }
    setPending({ ids, strategy });
    setError('');
    try {
      const res = await resolve(ids, strategy);
      if (!res?.ok) {
        setError(
          errorMessage(
            res,
            strategy === 'server'
              ? 'Could not replace the local changes with the server copy.'
              : 'Could not keep the local changes.'
          )
        );
      }
    } catch (err) {
      setError(err?.message || 'Could not resolve the conflict.');
    } finally {
      setPending(null);
    }
  }

  async function applyToAll(strategy) {
    if (busy) return;
    const ids = idsOf(list);
    if (ids.length === 0) return;
    if (!canResolve) {
      const allow = await dialogs.confirm(
        'This Relay build cannot resolve conflicts individually. Keep the local version for every conflict and replay it against the server?',
        { title: 'Keep local changes', okLabel: 'Keep local', danger: true }
      );
      if (!allow) return;
      if (typeof dismiss !== 'function') {
        setError('Conflict resolution is unavailable in this build.');
        return;
      }
      setPending({ ids, strategy: 'local' });
      setError('');
      try {
        const res = await dismiss();
        if (res && res.ok === false) {
          setError(errorMessage(res, 'Could not keep the local changes.'));
        }
      } catch (err) {
        setError(err?.message || 'Could not keep the local changes.');
      } finally {
        setPending(null);
      }
      return;
    }

    const allow = await dialogs.confirm(
      strategy === 'server'
        ? `${ids.length === 1 ? 'This change' : `All ${ids.length} changes`} will be replaced by the server copy. Local edits to ${ids.length === 1 ? 'it' : 'them'} are discarded.`
        : `${ids.length === 1 ? 'This local change' : `All ${ids.length} local changes`} will be replayed against the server and can overwrite edits from other devices.`,
      {
        title: strategy === 'server' ? 'Use server copy for all' : 'Keep local changes for all',
        okLabel: strategy === 'server' ? 'Use server' : 'Keep local',
        danger: true,
      }
    );
    if (!allow) return;
    await apply(ids, strategy);
  }

  return (
    <Modal
      title="Resolve sync conflicts"
      onClose={onClose}
      width={640}
      footer={
        <button type="button" className="mini-btn" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="cloud-conflicts" data-testid="cloud-conflict-modal">
        {error && (
          <div className="cloud-error" role="alert">
            {error}
          </div>
        )}

        {!canResolve && list.length > 0 && (
          <p className="cloud-conflict-hint">
            Per-change resolution needs a newer Relay build. You can still keep the local version
            for every conflict.
          </p>
        )}

        {list.length === 0 ? (
          <div className="team-empty">All conflicts resolved.</div>
        ) : (
          <>
            <div className="conflict-toolbar">
              <span className="conflict-summary">{conflictSummary(list)}</span>
              <div className="conflict-toolbar-actions">
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() => applyToAll('server')}
                  disabled={busy || !canResolve}
                >
                  {busy && pending?.strategy === 'server' ? 'Applying…' : 'Use server for all'}
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() => applyToAll('local')}
                  disabled={busy || !canKeepLocalAll}
                >
                  {busy && pending?.strategy === 'local' ? 'Applying…' : 'Keep local for all'}
                </button>
              </div>
            </div>

            <ul className="conflict-list">
              {list.map((conflict, index) => (
                <li key={conflictKey(conflict, index)} className="conflict-row">
                  <div className="conflict-main">
                    <span className="conflict-title">{describeConflict(conflict)}</span>
                    <span className="conflict-meta">
                      {conflict.id != null && (
                        <code title={String(conflict.id)}>{shortId(conflict.id)}</code>
                      )}
                      {conflict.at ? <span>{formatRelativeTime(conflict.at)}</span> : null}
                    </span>
                  </div>
                  <div className="conflict-actions">
                    <button
                      type="button"
                      className="mini-btn"
                      onClick={() => apply([conflict.id], 'server')}
                      disabled={busy || !canResolve || conflict.id == null}
                    >
                      Use server
                    </button>
                    <button
                      type="button"
                      className="mini-btn"
                      onClick={() => apply([conflict.id], 'local')}
                      disabled={busy || !canResolve || conflict.id == null}
                    >
                      Keep local
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Modal>
  );
}
