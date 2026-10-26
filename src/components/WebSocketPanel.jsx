import React, { useEffect, useRef, useState } from 'react';

// WebSocket conversation panel. It renders only session state pushed by the
// main process; opening/closing/sending is owned by App so the Send/Stop
// button and tab lifecycle stay in one place.

const MAX_LOG = 500;

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(at) {
  const date = new Date(at || Date.now());
  if (Number.isNaN(date.getTime())) return '';
  const base = date.toLocaleTimeString([], { hour12: false });
  return `${base}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function statusLabel(status) {
  if (!status) return 'Not connected';
  if (status.state === 'connecting') return 'Connecting…';
  if (status.state === 'open') return 'Open';
  if (status.state === 'closed') {
    const code = status.code != null ? ` ${status.code}` : '';
    return `Closed${code}`;
  }
  return 'Not connected';
}

export default function WebSocketPanel({
  status,
  log,
  error,
  onSend,
  onDisconnect,
  onClear,
}) {
  const [draft, setDraft] = useState('');
  const [binary, setBinary] = useState(false);
  const [sending, setSending] = useState(false);
  const logRef = useRef(null);
  const entries = Array.isArray(log) ? log.slice(-MAX_LOG) : [];
  const state = status?.state || 'idle';
  const canSend = state === 'open' && draft.trim() !== '' && !sending;

  // Keep the newest frame visible as messages stream in.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  async function submit() {
    if (!canSend) return;
    const value = binary ? { base64: draft.trim() } : { text: draft };
    setSending(true);
    try {
      const ok = await onSend?.(value);
      if (ok !== false) setDraft('');
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(event) {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    submit();
  }

  return (
    <section className="response-panel ws-panel" data-testid="ws-panel">
      <div className="response-status ws-status">
        <span className={`status-pill ws-state-${state}`} data-testid="ws-status">
          {statusLabel(status)}
        </span>
        <span className="meta">WebSocket</span>
        {status?.reason ? (
          <span className="meta ws-close-reason" title={status.reason}>
            {status.reason}
          </span>
        ) : null}
        <div className="status-actions">
          <button className="mini-btn" onClick={onClear} disabled={!entries.length}>
            Clear log
          </button>
          {(state === 'open' || state === 'connecting') && (
            <button className="mini-btn ws-disconnect" onClick={onDisconnect}>
              Disconnect
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="ws-error" role="alert" data-testid="ws-error">
          {error}
        </div>
      )}

      <div className="ws-log" ref={logRef} data-testid="ws-log">
        {entries.length === 0 ? (
          <div className="ws-empty">
            {state === 'open'
              ? 'Connected. Send a message to start the conversation.'
              : 'No messages yet.'}
          </div>
        ) : (
          entries.map((entry, index) => {
            const outgoing = entry.direction === 'out';
            const isBinary = entry.type === 'binary';
            return (
              <div
                key={`${entry.at || 0}-${index}`}
                className={`ws-message ${outgoing ? 'ws-out' : 'ws-in'}`}
                data-direction={outgoing ? 'out' : 'in'}
              >
                <div className="ws-message-head">
                  <span className="ws-arrow" aria-hidden="true">
                    {outgoing ? '↑' : '↓'}
                  </span>
                  <span className={`ws-type ${isBinary ? 'binary' : 'text'}`}>
                    {isBinary ? 'binary' : 'text'}
                  </span>
                  <span className="meta">{formatBytes(entry.size)}</span>
                  <span className="meta ws-time">{formatTime(entry.at)}</span>
                </div>
                <pre className={`ws-preview ${isBinary ? 'binary' : ''}`}>
                  {isBinary ? entry.base64 || '' : entry.data || ''}
                </pre>
                {isBinary && (
                  <span className="ws-binary-note">
                    base64 · {formatBytes(entry.size)}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="ws-composer">
        <textarea
          className="ws-input"
          placeholder={
            state === 'open'
              ? binary
                ? 'Base64 payload…'
                : 'Message (Enter to send, Shift+Enter for newline)'
              : 'Connect to send messages'
          }
          value={draft}
          disabled={state !== 'open'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          data-testid="ws-input"
        />
        <div className="ws-composer-actions">
          <label className="ws-binary-toggle" title="Interpret the input as base64">
            <input
              type="checkbox"
              checked={binary}
              onChange={(e) => setBinary(e.target.checked)}
            />
            Binary
          </label>
          <button
            className="send-btn"
            onClick={submit}
            disabled={!canSend}
            data-testid="ws-send"
          >
            Send
          </button>
        </div>
      </div>
    </section>
  );
}
