import React from 'react';
import Icon from './Icon.jsx';

function countRequests(items) {
  return (items || []).reduce(
    (total, item) =>
      total + (item.type === 'folder' ? countRequests(item.items) : 1),
    0
  );
}

function timeAgo(value) {
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function Stat({ icon, label, value }) {
  return (
    <div className="dashboard-stat">
      <span className="dashboard-stat-icon"><Icon name={icon} size={16} /></span>
      <span className="dashboard-stat-value">{value}</span>
      <span className="dashboard-stat-label">{label}</span>
    </div>
  );
}

export default function WorkspaceDashboard({
  collections = [],
  environments = [],
  history = [],
  activeEnv = null,
  onStartRequest,
  onOpenRequest,
  onOpenCollection,
}) {
  const requestCount = collections.reduce(
    (total, collection) => total + countRequests(collection.items),
    0
  );
  const recent = (history || []).filter((entry) => entry.snapshot).slice(0, 5);
  const visibleCollections = collections.slice(0, 4);

  return (
    <section className="workspace-dashboard" data-testid="workspace-dashboard">
      <div className="dashboard-inner">
        <header className="dashboard-head">
          <div>
            <div className="dashboard-kicker">Workspace</div>
            <h1 className="dashboard-title">Welcome to Relay</h1>
            <p className="dashboard-subtitle">
              Start a request, open a collection, or pick up where you left off.
            </p>
          </div>
          <button
            type="button"
            className="send-btn dashboard-primary"
            data-testid="dashboard-new-request"
            onClick={onStartRequest}
          >
            New Request
          </button>
        </header>

        <div className="dashboard-stats">
          <Stat icon="collection" label="Collections" value={collections.length} />
          <Stat icon="send" label="Requests" value={requestCount} />
          <Stat icon="globe" label="Environments" value={environments.length} />
          <Stat icon="clock" label="History" value={(history || []).length} />
        </div>

        <div className="dashboard-grid">
          <div className="dashboard-card">
            <div className="dashboard-card-head">
              <h2>Recent requests</h2>
              {recent.length > 0 && <span className="dashboard-muted">{recent.length}</span>}
            </div>
            {recent.length === 0 ? (
              <div className="dashboard-empty">
                No requests yet. Hit <strong>New Request</strong> to send your first one.
              </div>
            ) : (
              <div className="dashboard-recent">
                {recent.map((entry) => (
                  <button
                    type="button"
                    key={entry.id}
                    className="dashboard-recent-item"
                    onClick={() => onOpenRequest?.(entry.snapshot)}
                  >
                    <span className={`method-tag method-${entry.method}`}>
                      {entry.method || 'GET'}
                    </span>
                    <span className="dashboard-recent-url" title={entry.url}>
                      {entry.url}
                    </span>
                    {entry.status != null ? (
                      <span className={`history-status s${Math.floor(entry.status / 100)}`}>
                        {entry.status}
                      </span>
                    ) : (
                      !entry.ok && <span className="history-status s5">error</span>
                    )}
                    <span className="dashboard-recent-time">{timeAgo(entry.at)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="dashboard-card">
            <div className="dashboard-card-head">
              <h2>Quick start</h2>
            </div>
            <div className="dashboard-actions">
              <button
                type="button"
                className="dashboard-action"
                onClick={onStartRequest}
              >
                <Icon name="send" size={15} />
                <span>
                  <strong>New request</strong>
                  <small>Open a blank request editor</small>
                </span>
              </button>
              <div className="dashboard-tip">
                <span className="dashboard-key">⌘/Ctrl + Enter</span>
                <span>Send the active request</span>
              </div>
              <div className="dashboard-tip">
                <span className="dashboard-key">⌘/Ctrl + S</span>
                <span>Save the active request</span>
              </div>
              <div className="dashboard-tip">
                <span className="dashboard-key">⌘/Ctrl + K</span>
                <span>Search requests and collections</span>
              </div>
            </div>
          </div>
        </div>

        <div className="dashboard-card">
          <div className="dashboard-card-head">
            <h2>Collections</h2>
            <span className="dashboard-muted">
              {activeEnv ? `Environment: ${activeEnv.name}` : 'No active environment'}
            </span>
          </div>
          {visibleCollections.length === 0 ? (
            <div className="dashboard-empty">
              No collections yet. Use <strong>+ New</strong> or <strong>Import</strong> in the sidebar.
            </div>
          ) : (
            <div className="dashboard-collections">
              {visibleCollections.map((collection) => (
                <button
                  type="button"
                  key={collection.id}
                  className="dashboard-collection"
                  onClick={() => onOpenCollection?.(collection.id)}
                  title="Open collection settings"
                >
                  <Icon name="collection" size={15} />
                  <span className="dashboard-collection-name">{collection.name}</span>
                  <span className="dashboard-collection-count">
                    {countRequests(collection.items)} requests
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
