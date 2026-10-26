import React, { useCallback, useEffect, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import Icon from './Icon.jsx';

const hasBridge = typeof window !== 'undefined' && !!window.api;

function formatTime(at) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString();
}

// Local mock server control panel: pick a collection, start it, watch the
// routes it exposes and the requests it serves. The main process owns the
// actual server; this modal polls mock:status while it is open.
export default function MockServerModal({ store, onClose }) {
  const collections = store?.collections || [];

  const [collectionId, setCollectionId] = useState('');
  const [port, setPort] = useState('0');
  const [delayMs, setDelayMs] = useState('0');
  const [status, setStatus] = useState({ running: false, url: null, port: null, routes: [], logs: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!hasBridge) return;
    try {
      const next = await window.api.mockStatus();
      if (aliveRef.current && next) setStatus(next);
    } catch {
      /* transient IPC failure; the next poll retries */
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => {
      aliveRef.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  const start = async () => {
    if (!hasBridge) {
      setError('Mock server is only available in the desktop app.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await window.api.mockStart({
        collectionId: collectionId || undefined,
        port: Number(port) || 0,
        delayMs: Number(delayMs) || 0,
      });
      if (!result?.ok) {
        setError(result?.error || 'Failed to start mock server');
      } else {
        setStatus({
          running: true,
          url: result.url,
          port: result.port,
          routes: result.routes || [],
          logs: [],
        });
        refresh();
      }
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!hasBridge) return;
    setBusy(true);
    setError('');
    try {
      await window.api.mockStop();
      setStatus({ running: false, url: null, port: null, routes: [], logs: [] });
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const copyUrl = async () => {
    if (!status.url) return;
    try {
      await navigator.clipboard.writeText(status.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      setError(err?.message || 'Could not copy the URL');
    }
  };

  const routes = status.routes || [];
  const logs = status.logs || [];

  return (
    <Modal title="Mock server" onClose={onClose} width={760}>
      <div className="form-row">
        <label htmlFor="mock-collection">Collection</label>
        <select
          id="mock-collection"
          data-testid="mock-collection"
          value={collectionId}
          onChange={(e) => setCollectionId(e.target.value)}
          disabled={status.running}
        >
          <option value="">All collections</option>
          {collections.map((collection) => (
            <option key={collection.id} value={collection.id}>
              {collection.name}
            </option>
          ))}
        </select>
      </div>

      <div className="mock-fields">
        <div className="form-row">
          <label htmlFor="mock-port">Port (0 = random)</label>
          <input
            id="mock-port"
            data-testid="mock-port"
            type="number"
            min="0"
            max="65535"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            disabled={status.running}
          />
        </div>
        <div className="form-row">
          <label htmlFor="mock-delay">Delay (ms)</label>
          <input
            id="mock-delay"
            data-testid="mock-delay"
            type="number"
            min="0"
            max="10000"
            value={delayMs}
            onChange={(e) => setDelayMs(e.target.value)}
            disabled={status.running}
          />
        </div>
      </div>

      <div className="mock-actions">
        <button
          type="button"
          className="send-btn"
          data-testid="mock-start"
          onClick={start}
          disabled={busy || status.running}
        >
          <Icon name="play" size={12} /> Start
        </button>
        <button
          type="button"
          className="mini-btn"
          data-testid="mock-stop"
          onClick={stop}
          disabled={busy || !status.running}
        >
          Stop
        </button>
        <span className={`mock-state ${status.running ? 'on' : 'off'}`}>
          {status.running ? 'Running' : 'Stopped'}
        </span>
      </div>

      {error && <div className="auth-hint mock-error">{error}</div>}

      {status.running && (
        <>
          <div className="mock-url-row">
            <code className="mock-url" data-testid="mock-base-url">{status.url}</code>
            <button
              type="button"
              className="mini-btn"
              data-testid="mock-copy"
              onClick={copyUrl}
              title="Copy base URL"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>

          <div className="mock-section">
            <div className="mock-section-title">
              Routes <span className="badge">{routes.length}</span>
            </div>
            {routes.length === 0 ? (
              <div className="auth-hint">No request routes in this collection.</div>
            ) : (
              <ul className="mock-routes" data-testid="mock-routes">
                {routes.map((route, index) => (
                  <li key={`${route.method}-${route.path}-${index}`}>
                    <span className={`mock-method ${route.method.toLowerCase()}`}>{route.method}</span>
                    <code>{route.path}</code>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      <div className="mock-section">
        <div className="mock-section-title">
          Requests <span className="badge">{logs.length}</span>
        </div>
        {logs.length === 0 ? (
          <div className="auth-hint">No requests yet.</div>
        ) : (
          <div className="mock-log-wrap">
            <table className="mock-logs" data-testid="mock-logs">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Method</th>
                  <th>Path</th>
                  <th>Status</th>
                  <th>ms</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((entry, index) => (
                  <tr key={`${entry.at}-${index}`} className={entry.status >= 400 ? 'failed' : undefined}>
                    <td>{formatTime(entry.at)}</td>
                    <td>{entry.method}</td>
                    <td className="mock-log-path">{entry.path}</td>
                    <td>{entry.status}</td>
                    <td>{entry.ms}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}
