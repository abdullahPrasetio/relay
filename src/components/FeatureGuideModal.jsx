import React, { useMemo, useState } from 'react';
import Modal from './Modal.jsx';

export default function FeatureGuideModal({
  features,
  seen,
  enabled,
  storageError,
  onToggleEnabled,
  onShow,
  onReset,
  onClose,
}) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return features;
    return features.filter((feature) =>
      `${feature.group} ${feature.title} ${feature.body}`.toLowerCase().includes(q)
    );
  }, [features, query]);

  return (
    <Modal
      title="Feature guide"
      onClose={onClose}
      width={760}
      footer={
        <>
          <label className="feature-guide-toggle">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => onToggleEnabled(event.target.checked)}
              data-testid="feature-guide-enabled"
            />
            Show feature tips automatically
          </label>
          <button type="button" className="mini-btn" onClick={onReset} data-testid="feature-guide-reset">
            Reset tips
          </button>
          <button type="button" className="send-btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="feature-guide" data-testid="feature-guide">
        {storageError && (
          <p className="auth-hint feature-guide-error">
            Tip history could not be saved in this session. Tips may reappear after a restart.
          </p>
        )}
        <input
          className="feature-guide-search"
          placeholder="Search features…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          data-testid="feature-guide-search"
        />
        <div className="feature-guide-list">
          {filtered.map((feature) => {
            const entry = seen?.[feature.id];
            const status = entry ? (entry.action === 'skipped' ? 'Skipped' : 'Seen') : 'New';
            return (
              <div className="feature-guide-row" key={feature.id}>
                <div className="feature-guide-copy">
                  <span className="feature-guide-group">{feature.group}</span>
                  <strong>{feature.title}</strong>
                  <p>{feature.body}</p>
                </div>
                <span className={`feature-guide-status ${status.toLowerCase()}`}>{status}</span>
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() => onShow(feature)}
                  data-testid={`feature-guide-show-${feature.id}`}
                >
                  Show
                </button>
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div className="feature-guide-empty">No features match this search.</div>
          )}
        </div>
      </div>
    </Modal>
  );
}
