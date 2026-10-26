import React, { useEffect, useRef, useState } from 'react';

// MQTT conversation panel. Session state is pushed by the main process;
// opening/closing/publishing is owned by App so Send/Stop and the tab
// lifecycle stay in one place.

const MAX_LOG = 500;
const QOS_LEVELS = [0, 1, 2];

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
  if (status.state === 'open') return 'Connected';
  if (status.state === 'closed') return 'Closed';
  return 'Not connected';
}

function preview(entry) {
  if (entry.payload !== undefined) return entry.payload || '';
  return entry.text !== undefined ? entry.text : '';
}

export default function MqttPanel({
  status,
  log,
  error,
  onSubscribe,
  onUnsubscribe,
  onPublish,
  onDisconnect,
  onClear,
}) {
  const [subTopic, setSubTopic] = useState('');
  const [subQos, setSubQos] = useState(0);
  const [pubTopic, setPubTopic] = useState('');
  const [pubPayload, setPubPayload] = useState('');
  const [pubQos, setPubQos] = useState(0);
  const [retain, setRetain] = useState(false);
  const [busy, setBusy] = useState(false);
  const logRef = useRef(null);

  const entries = Array.isArray(log) ? log.slice(-MAX_LOG) : [];
  const state = status?.state || 'idle';
  const connected = state === 'open';
  const canSubscribe = connected && subTopic.trim() !== '' && !busy;
  const canPublish = connected && pubTopic.trim() !== '' && !busy;

  // Keep the newest message visible as broker traffic streams in.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  async function subscribe() {
    if (!canSubscribe) return;
    setBusy(true);
    try {
      await onSubscribe?.(subTopic.trim(), Number(subQos));
    } finally {
      setBusy(false);
    }
  }

  async function unsubscribe() {
    if (!connected || subTopic.trim() === '' || busy) return;
    setBusy(true);
    try {
      await onUnsubscribe?.(subTopic.trim());
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!canPublish) return;
    setBusy(true);
    try {
      const ok = await onPublish?.({
        topic: pubTopic.trim(),
        payload: pubPayload,
        qos: Number(pubQos),
        retain,
      });
      if (ok !== false) setPubPayload('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="response-panel mqtt-panel" data-testid="mqtt-panel">
      <div className="response-status mqtt-status">
        <span className={`status-pill ws-state-${state}`} data-testid="mqtt-status">
          {statusLabel(status)}
        </span>
        <span className="meta">MQTT</span>
        {status?.clientId ? (
          <span className="meta mqtt-client-id" data-testid="mqtt-client-id">
            client {status.clientId}
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
        <div className="ws-error" role="alert" data-testid="mqtt-error">
          {error}
        </div>
      )}

      <div className="mqtt-subscribe">
        <input
          className="mqtt-input"
          placeholder="Topic filter (e.g. sensors/#)"
          value={subTopic}
          disabled={!connected}
          onChange={(e) => setSubTopic(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              subscribe();
            }
          }}
          data-testid="mqtt-sub-topic"
        />
        <select
          className="mqtt-select"
          value={subQos}
          disabled={!connected}
          onChange={(e) => setSubQos(Number(e.target.value))}
          title="Subscription QoS"
          data-testid="mqtt-sub-qos"
        >
          {QOS_LEVELS.map((qos) => (
            <option key={qos} value={qos}>
              QoS {qos}
            </option>
          ))}
        </select>
        <button
          className="mini-btn"
          onClick={subscribe}
          disabled={!canSubscribe}
          data-testid="mqtt-subscribe"
        >
          Subscribe
        </button>
        <button
          className="mini-btn"
          onClick={unsubscribe}
          disabled={!connected || subTopic.trim() === '' || busy}
          data-testid="mqtt-unsubscribe"
        >
          Unsubscribe
        </button>
      </div>

      <div className="ws-log" ref={logRef} data-testid="mqtt-log">
        {entries.length === 0 ? (
          <div className="ws-empty">
            {connected
              ? 'Connected. Subscribe to a topic to receive messages.'
              : 'No messages yet.'}
          </div>
        ) : (
          entries.map((entry, index) => {
            const outgoing = entry.direction === 'out';
            const binary = entry.payload !== undefined;
            return (
              <div
                key={`${entry.at || 0}-${index}`}
                className={`ws-message ${outgoing ? 'ws-out' : 'ws-in'} mqtt-message`}
                data-direction={outgoing ? 'out' : 'in'}
              >
                <div className="ws-message-head">
                  <span className="ws-arrow" aria-hidden="true">
                    {outgoing ? '↑' : '↓'}
                  </span>
                  <span className="mqtt-topic" title={entry.topic}>
                    {entry.topic || '(no topic)'}
                  </span>
                  <span className="mqtt-badge">QoS {Number(entry.qos) || 0}</span>
                  {entry.retain ? <span className="mqtt-badge retain">retain</span> : null}
                  <span className="meta">{formatBytes(entry.size)}</span>
                  <span className="meta ws-time">{formatTime(entry.at)}</span>
                </div>
                <pre className={`ws-preview ${binary ? 'binary' : ''}`}>{preview(entry)}</pre>
                {binary && (
                  <span className="ws-binary-note">
                    base64 · {formatBytes(entry.size)}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="mqtt-publish">
        <div className="mqtt-publish-head">
          <input
            className="mqtt-input"
            placeholder="Publish topic"
            value={pubTopic}
            disabled={!connected}
            onChange={(e) => setPubTopic(e.target.value)}
            data-testid="mqtt-pub-topic"
          />
          <select
            className="mqtt-select"
            value={pubQos}
            disabled={!connected}
            onChange={(e) => setPubQos(Number(e.target.value))}
            title="Publish QoS"
            data-testid="mqtt-pub-qos"
          >
            {QOS_LEVELS.map((qos) => (
              <option key={qos} value={qos}>
                QoS {qos}
              </option>
            ))}
          </select>
          <label className="ws-binary-toggle" title="Publish with the retain flag">
            <input
              type="checkbox"
              checked={retain}
              disabled={!connected}
              onChange={(e) => setRetain(e.target.checked)}
              data-testid="mqtt-retain"
            />
            Retain
          </label>
        </div>
        <div className="ws-composer">
          <textarea
            className="ws-input"
            placeholder={
              connected
                ? 'Payload (Enter to publish, Shift+Enter for newline)'
                : 'Connect to publish messages'
            }
            value={pubPayload}
            disabled={!connected}
            onChange={(e) => setPubPayload(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.shiftKey) return;
              e.preventDefault();
              publish();
            }}
            rows={3}
            data-testid="mqtt-payload"
          />
          <div className="ws-composer-actions">
            <button
              className="send-btn"
              onClick={publish}
              disabled={!canPublish}
              data-testid="mqtt-publish"
            >
              Publish
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
