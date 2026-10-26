import React, { useEffect, useRef, useState } from 'react';

// gRPC panel. Layout decision (kept consistent): the lower half is a single
// panel that owns gRPC configuration, the unary result and the server-stream
// log. `ResponsePanel` is not rendered for gRPC URLs, so there is exactly one
// result area per tab.
//
// Configuration (proto path, service, method, message, metadata) is persisted
// into the request through `onChange`, so it survives tab switches and saves.
// Calls live in App: `onInvoke` performs a unary call through the normal Send
// pipeline; `onStartStream`/`onCancelStream` own the stream id and the tab
// lifecycle.
//
// Limits: only unary and server-streaming methods are callable here. Client
// and bidi streaming are listed in the method picker but rejected in the UI.

const MAX_LOG = 500;

function formatTime(at) {
  const date = new Date(at || Date.now());
  if (Number.isNaN(date.getTime())) return '';
  const base = date.toLocaleTimeString([], { hour12: false });
  return `${base}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function formatStatus(status) {
  if (!status) return 'Ended';
  const code = status.code != null ? status.code : 0;
  const details = status.details || (code === 0 ? 'OK' : '');
  return details ? `${details} (${code})` : `code ${code}`;
}

function streamingLabel(streaming) {
  if (streaming === 'server') return 'server stream';
  if (streaming === 'client') return 'client stream';
  if (streaming === 'bidi') return 'bidi stream';
  return 'unary';
}

function messageProblem(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return 'Message must be a JSON object';
    }
    return null;
  } catch (err) {
    return `Invalid JSON: ${err.message}`;
  }
}

export default function GrpcPanel({
  request,
  response,
  sending,
  streamActive,
  streamLog,
  streamError,
  onChange,
  onInvoke,
  onStartStream,
  onCancelStream,
  onClearLog,
}) {
  const api = typeof window !== 'undefined' ? window.api : null;
  const grpc = request?.grpc || {};
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);

  const protoPath = grpc.protoPath || '';
  const metadata = Array.isArray(grpc.metadata) ? grpc.metadata : [];
  const entries = Array.isArray(streamLog) ? streamLog.slice(-MAX_LOG) : [];
  const logRef = useRef(null);

  // Latest request/handler for effect callbacks, so loading a proto does not
  // re-run every time the user edits an unrelated field.
  const latest = useRef({ request, onChange });
  latest.current = { request, onChange };

  function patchGrpc(patch) {
    if (typeof onChange !== 'function') return;
    onChange({ ...request, grpc: { ...grpc, ...patch } });
  }

  // Load the service list whenever the selected .proto changes. Stale
  // responses are dropped so a fast file switch cannot show the wrong file.
  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    if (!protoPath) {
      setServices([]);
      setLoading(false);
      return undefined;
    }
    if (!api || typeof api.grpcServices !== 'function') {
      setServices([]);
      setLoading(false);
      setLoadError('gRPC is only available in the desktop app.');
      return undefined;
    }
    setLoading(true);
    api
      .grpcServices({ protoPath })
      .then((result) => {
        if (cancelled) return;
        if (!result?.ok) {
          setServices([]);
          setLoadError(result?.error || 'Could not load the proto file');
          return;
        }
        const next = Array.isArray(result.services) ? result.services : [];
        setServices(next);

        // Keep a valid existing selection; otherwise pick the first service
        // and method so Invoke works immediately after choosing a file.
        const { request: current, onChange: change } = latest.current;
        const currentGrpc = current?.grpc || {};
        const currentService = next.find((service) => service.name === currentGrpc.service);
        const service = currentService || next[0];
        const currentMethod = service?.methods.find(
          (method) => method.name === currentGrpc.method
        );
        const method = currentMethod || service?.methods[0];
        if (
          typeof change === 'function' &&
          current &&
          service &&
          (service.name !== currentGrpc.service || method?.name !== currentGrpc.method)
        ) {
          change({
            ...current,
            grpc: {
              ...currentGrpc,
              service: service.name,
              method: method?.name || '',
            },
          });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setServices([]);
        setLoadError(err?.message || String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Reload only when the file changes; the selection is reconciled above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [protoPath]);

  // Keep the newest stream message visible.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  const selectedService =
    services.find((service) => service.name === grpc.service) || services[0] || null;
  const methods = selectedService?.methods || [];
  const selectedMethod =
    methods.find((method) => method.name === grpc.method) || methods[0] || null;
  const kind = selectedMethod?.streaming || null;
  const jsonError = messageProblem(grpc.message);
  const ready = !!protoPath && !!selectedService && !!selectedMethod && !jsonError;
  const busy = !!sending || !!streamActive;
  const canInvoke = ready && kind === 'unary' && !busy;
  const canStream = ready && kind === 'server' && !busy;

  async function chooseProto() {
    if (!api || typeof api.pickFile !== 'function') return;
    try {
      const picked = await api.pickFile();
      if (!picked?.filePath) return;
      patchGrpc({ protoPath: picked.filePath, service: '', method: '' });
    } catch (err) {
      setLoadError(err?.message || String(err));
    }
  }

  function updateMetadata(index, patch) {
    patchGrpc({
      metadata: metadata.map((row, idx) => (idx === index ? { ...row, ...patch } : row)),
    });
  }

  function addMetadata() {
    patchGrpc({ metadata: [...metadata, { key: '', value: '', enabled: true }] });
  }

  function removeMetadata(index) {
    patchGrpc({ metadata: metadata.filter((_, idx) => idx !== index) });
  }

  const hasSelectionError =
    !!protoPath && !loading && !loadError && (!selectedService || !selectedMethod);

  return (
    <section className="response-panel grpc-panel" data-testid="grpc-panel">
      <div className="response-status grpc-status">
        <span
          className={`status-pill ${streamActive ? 'ws-state-open' : 'ws-state-idle'}`}
          data-testid="grpc-status"
        >
          {streamActive ? 'Streaming' : 'gRPC'}
        </span>
        <span className="meta grpc-target" title={request?.url || ''}>
          {request?.url || 'No target'}
        </span>
        <div className="status-actions">
          <button
            className="mini-btn"
            onClick={onClearLog}
            disabled={!entries.length}
            data-testid="grpc-clear"
          >
            Clear log
          </button>
          {streamActive ? (
            <button
              className="mini-btn ws-disconnect"
              onClick={onCancelStream}
              data-testid="grpc-cancel"
            >
              Cancel
            </button>
          ) : (
            <button
              className="mini-btn"
              onClick={onStartStream}
              disabled={!canStream}
              title={
                kind && kind !== 'server'
                  ? 'Select a server-streaming method'
                  : 'Start server stream'
              }
              data-testid="grpc-stream"
            >
              Stream
            </button>
          )}
          <button
            className="send-btn grpc-invoke"
            onClick={onInvoke}
            disabled={!canInvoke}
            title={kind && kind !== 'unary' ? 'Select a unary method' : 'Invoke unary call'}
            data-testid="grpc-invoke"
          >
            Invoke
          </button>
        </div>
      </div>

      <div className="grpc-config">
        <div className="grpc-proto-row">
          <input
            className="mqtt-input grpc-proto-path"
            value={protoPath}
            readOnly
            placeholder="Choose a .proto file"
            data-testid="grpc-proto-path"
          />
          <button className="mini-btn" onClick={chooseProto} data-testid="grpc-choose-proto">
            Choose .proto
          </button>
        </div>

        <div className="grpc-select-row">
          <label className="grpc-field">
            <span className="grpc-label">Service</span>
            <select
              className="mqtt-select"
              value={selectedService?.name || ''}
              disabled={!services.length}
              onChange={(e) => {
                const service = services.find((item) => item.name === e.target.value);
                patchGrpc({
                  service: e.target.value,
                  method: service?.methods[0]?.name || '',
                });
              }}
              data-testid="grpc-service"
            >
              {services.length === 0 ? (
                <option value="">{loading ? 'Loading…' : 'No services'}</option>
              ) : (
                services.map((service) => (
                  <option key={service.name} value={service.name}>
                    {service.name}
                  </option>
                ))
              )}
            </select>
          </label>

          <label className="grpc-field">
            <span className="grpc-label">Method</span>
            <select
              className="mqtt-select"
              value={selectedMethod?.name || ''}
              disabled={!methods.length}
              onChange={(e) => patchGrpc({ method: e.target.value })}
              data-testid="grpc-method"
            >
              {methods.length === 0 ? (
                <option value="">No methods</option>
              ) : (
                methods.map((method) => (
                  <option key={method.name} value={method.name}>
                    {method.name} ({streamingLabel(method.streaming)})
                  </option>
                ))
              )}
            </select>
          </label>
        </div>

        {selectedMethod && (
          <div className="grpc-signature" data-testid="grpc-signature">
            <code>
              {selectedMethod.requestType} →{' '}
              {selectedMethod.streaming === 'server' ? 'stream ' : ''}
              {selectedMethod.responseType}
            </code>
          </div>
        )}

        <label className="grpc-field grpc-message-field">
          <span className="grpc-label">Message (JSON)</span>
          <textarea
            className="ws-input grpc-message"
            value={grpc.message ?? ''}
            onChange={(e) => patchGrpc({ message: e.target.value })}
            rows={7}
            spellCheck={false}
            data-testid="grpc-message"
          />
        </label>

        <div className="grpc-metadata">
          <div className="grpc-metadata-head">
            <span className="grpc-label">Metadata</span>
            <button className="mini-btn" onClick={addMetadata} data-testid="grpc-metadata-add">
              Add
            </button>
          </div>
          {metadata.length === 0 ? (
            <span className="meta">No metadata rows.</span>
          ) : (
            metadata.map((row, index) => (
              <div className="grpc-metadata-row" key={`meta-${index}`}>
                <input
                  className="mqtt-input"
                  placeholder="key"
                  value={row.key ?? ''}
                  onChange={(e) => updateMetadata(index, { key: e.target.value })}
                  data-testid={`grpc-metadata-key-${index}`}
                />
                <input
                  className="mqtt-input"
                  placeholder="value"
                  value={row.value ?? ''}
                  onChange={(e) => updateMetadata(index, { value: e.target.value })}
                  data-testid={`grpc-metadata-value-${index}`}
                />
                <button
                  className="mini-btn"
                  onClick={() => removeMetadata(index)}
                  title="Remove metadata row"
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {(loadError || jsonError || hasSelectionError || streamError) && (
        <div className="ws-error" role="alert" data-testid="grpc-error">
          {loadError ||
            jsonError ||
            (hasSelectionError
              ? 'Choose a service and method from the proto file.'
              : streamError)}
        </div>
      )}

      <div className="grpc-output">
        {response && (
          <div
            className={`grpc-result ${response.ok ? 'ok' : 'error'}`}
            data-testid="grpc-result"
          >
            <div className="grpc-result-head">
              <span className={`status-pill ${response.ok ? 'ws-state-open' : 'ws-state-closed'}`}>
                {response.ok ? 'OK' : 'Error'}
              </span>
              <span className="meta">{Number(response.timeMs) || 0} ms</span>
            </div>
            {response.ok ? (
              <pre className="grpc-result-body">{response.body}</pre>
            ) : (
              <div className="grpc-result-error">{response.error}</div>
            )}
          </div>
        )}

        <div className="ws-log grpc-log" ref={logRef} data-testid="grpc-log">
          {entries.length === 0 ? (
            <div className="ws-empty">
              {streamActive
                ? 'Streaming. Responses appear here.'
                : 'No stream messages yet.'}
            </div>
          ) : (
            entries.map((entry, index) => (
              <div
                key={`${entry.at || 0}-${index}`}
                className={`ws-message grpc-event grpc-event-${entry.type || 'unknown'}`}
              >
                <div className="ws-message-head">
                  <span className="ws-type text">{entry.type || 'event'}</span>
                  <span className="meta ws-time">{formatTime(entry.at)}</span>
                </div>
                {entry.type === 'data' ? (
                  <pre className="ws-preview">{JSON.stringify(entry.message, null, 2)}</pre>
                ) : entry.type === 'end' ? (
                  <div className="grpc-event-text">{formatStatus(entry.status)}</div>
                ) : (
                  <div className="grpc-event-text">{entry.message || 'Unknown error'}</div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
