import React, { useEffect, useRef, useState } from 'react';

// Socket.IO conversation panel. Session state is pushed by the main process;
// connecting/emitting/disconnecting is owned by App so Send/Stop and the tab
// lifecycle stay in one place.

const MAX_LOG = 500;

function formatTime(at) {
  const date = new Date(at || Date.now());
  if (Number.isNaN(date.getTime())) return '';
  const base = date.toLocaleTimeString([], { hour12: false });
  return `${base}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function formatArgs(args) {
  const list = Array.isArray(args) ? args : args === undefined ? [] : [args];
  if (!list.length) return '';
  const value = list.length === 1 ? list[0] : list;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function statusLabel(status) {
  if (!status) return 'Not connected';
  if (status.state === 'connecting') return 'Connecting…';
  if (status.state === 'open') return 'Connected';
  if (status.state === 'closed') return 'Disconnected';
  return 'Not connected';
}

export default function SocketIoPanel({
  status,
  log,
  error,
  onEmit,
  onDisconnect,
  onClear,
}) {
  const [eventName, setEventName] = useState('');
  const [argText, setArgText] = useState('');
  const [parseError, setParseError] = useState('');
  const [busy, setBusy] = useState(false);
  const logRef = useRef(null);

  const entries = Array.isArray(log) ? log.slice(-MAX_LOG) : [];
  const state = status?.state || 'idle';
  const connected = state === 'open';
  const canEmit = connected && eventName.trim() !== '' && !busy;

  // Keep the newest event visible as server pushes stream in.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  function parseArgs() {
    const raw = argText.trim();
    if (!raw) return [];
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : [value];
  }

  async function submit() {
    if (!canEmit) return;
    let args;
    try {
      args = parseArgs();
    } catch (err) {
      setParseError(`Arguments must be valid JSON: ${err.message}`);
      return;
    }
    setParseError('');
    setBusy(true);
    try {
      const ok = await onEmit?.(eventName.trim(), args);
      if (ok !== false) setArgText('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="response-panel socketio-panel" data-testid="socketio-panel">
      <div className="response-status socketio-status">
        <span className={`status-pill ws-state-${state}`} data-testid="socketio-status">
          {statusLabel(status)}
        </span>
        <span className="meta">Socket.IO</span>
        {status?.socketId ? (
          <span className="meta socketio-socket-id" data-testid="socketio-socket-id">
            id {status.socketId}
          </span>
        ) : null}
        {status?.transport ? (
          <span className="mqtt-badge" data-testid="socketio-transport">
            {status.transport}
          </span>
        ) : null}
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
        <div className="ws-error" role="alert" data-testid="socketio-error">
          {error}
        </div>
      )}

      <div className="ws-log" ref={logRef} data-testid="socketio-log">
        {entries.length === 0 ? (
          <div className="ws-empty">
            {connected ? 'Connected. Emit an event to start the conversation.' : 'No events yet.'}
          </div>
        ) : (
          entries.map((entry, index) => {
            const outgoing = entry.direction === 'out';
            return (
              <div
                key={`${entry.at || 0}-${index}`}
                className={`ws-message ${outgoing ? 'ws-out' : 'ws-in'} socketio-message`}
                data-direction={outgoing ? 'out' : 'in'}
              >
                <div className="ws-message-head">
                  <span className="ws-arrow" aria-hidden="true">
                    {outgoing ? '↑' : '↓'}
                  </span>
                  <span className="socketio-event" title={entry.event}>
                    {entry.event || '(unnamed event)'}
                  </span>
                  <span className="meta ws-time">{formatTime(entry.at)}</span>
                </div>
                <pre className="ws-preview">{formatArgs(entry.args)}</pre>
              </div>
            );
          })
        )}
      </div>

      <div className="socketio-composer">
        <div className="socketio-composer-head">
          <input
            className="mqtt-input"
            placeholder="Event name (e.g. chat message)"
            value={eventName}
            disabled={!connected}
            onChange={(e) => setEventName(e.target.value)}
            data-testid="socketio-event"
          />
        </div>
        <div className="ws-composer">
          <textarea
            className="ws-input"
            placeholder={
              connected
                ? 'JSON argument (empty sends none, Enter to emit, Shift+Enter for newline)'
                : 'Connect to emit events'
            }
            value={argText}
            disabled={!connected}
            onChange={(e) => setArgText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.shiftKey) return;
              e.preventDefault();
              submit();
            }}
            rows={3}
            data-testid="socketio-args"
          />
          <div className="ws-composer-actions">
            <button
              className="send-btn"
              onClick={submit}
              disabled={!canEmit}
              data-testid="socketio-emit"
            >
              Emit
            </button>
          </div>
        </div>
        {parseError && (
          <div className="auth-hint" role="alert" data-testid="socketio-args-error">
            {parseError}
          </div>
        )}
      </div>
    </section>
  );
}
