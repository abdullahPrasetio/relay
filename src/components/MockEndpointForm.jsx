import React, { useState } from 'react';
import CodeEditor from './CodeEditor.jsx';
import KeyValueEditor from './KeyValueEditor.jsx';
import { MOCK_LIMITS, MOCK_METHODS, buildMockPayload } from '../lib/mockPayload.js';
import { headerRows } from '../lib/mockUi.js';

function initialForm(endpoint) {
  return {
    name: endpoint?.name || '',
    method: endpoint?.method || 'GET',
    path: endpoint?.path || '/',
    statusCode: String(endpoint?.statusCode ?? 200),
    delayMs: String(endpoint?.delayMs ?? 0),
    delayMaxMs: String(endpoint?.delayMaxMs ?? 0),
    errorRate: String(endpoint?.errorRate ?? 0),
    errorStatusCode: String(endpoint?.errorStatusCode ?? 500),
    enabled: endpoint?.enabled !== false,
  };
}

// Create/edit form for one server mock. The parent owns the IPC call; this
// component only validates and emits the relay-api payload.
export default function MockEndpointForm({ endpoint = null, busy = false, onSubmit, onCancel }) {
  const editing = Boolean(endpoint?.id);
  const [form, setForm] = useState(() => initialForm(endpoint));
  const [headers, setHeaders] = useState(() => headerRows(endpoint?.responseHeaders));
  const [body, setBody] = useState(endpoint?.responseBody || '');
  const [error, setError] = useState('');

  const patch = (next) => setForm((prev) => ({ ...prev, ...next }));

  function submit(event) {
    event.preventDefault();
    setError('');
    try {
      const payload = buildMockPayload({
        ...form,
        statusCode: Number(form.statusCode),
        delayMs: Number(form.delayMs),
        delayMaxMs: Number(form.delayMaxMs),
        errorRate: Number(form.errorRate),
        errorStatusCode: Number(form.errorStatusCode),
        responseHeaders: headers,
        responseBody: body,
      });
      onSubmit?.(payload);
    } catch (err) {
      setError(err?.message || String(err));
    }
  }

  return (
    <form className="mock-form" onSubmit={submit} data-testid="mock-endpoint-form">
      <div className="mock-form-head">
        <strong>{editing ? `Edit ${endpoint.name || endpoint.path}` : 'New mock'}</strong>
        <label className="mock-inline-check">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          Enabled
        </label>
      </div>

      <div className="mock-form-grid">
        <div className="form-row">
          <label htmlFor="mock-name">Name</label>
          <input
            id="mock-name"
            data-testid="mock-name"
            value={form.name}
            placeholder="Method + path when empty"
            maxLength={MOCK_LIMITS.nameLength}
            onChange={(e) => patch({ name: e.target.value })}
          />
        </div>
        <div className="form-row">
          <label htmlFor="mock-path">Path</label>
          <input
            id="mock-path"
            data-testid="mock-path"
            value={form.path}
            placeholder="/orders/{id}"
            onChange={(e) => patch({ path: e.target.value })}
          />
        </div>
        <div className="form-row">
          <label htmlFor="mock-method">Method</label>
          <select
            id="mock-method"
            data-testid="mock-method"
            value={form.method}
            onChange={(e) => patch({ method: e.target.value })}
          >
            {MOCK_METHODS.map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label htmlFor="mock-status">Status code</label>
          <input
            id="mock-status"
            data-testid="mock-status"
            type="number"
            min="100"
            max="599"
            value={form.statusCode}
            onChange={(e) => patch({ statusCode: e.target.value })}
          />
        </div>
        <div className="form-row">
          <label htmlFor="mock-delay-ms">Delay (ms)</label>
          <input
            id="mock-delay-ms"
            type="number"
            min="0"
            max={MOCK_LIMITS.delayMs}
            value={form.delayMs}
            onChange={(e) => patch({ delayMs: e.target.value })}
          />
        </div>
        <div className="form-row">
          <label htmlFor="mock-delay-max">Delay max (ms)</label>
          <input
            id="mock-delay-max"
            type="number"
            min="0"
            max={MOCK_LIMITS.delayMs}
            value={form.delayMaxMs}
            onChange={(e) => patch({ delayMaxMs: e.target.value })}
          />
        </div>
        <div className="form-row">
          <label htmlFor="mock-error-rate">Error rate (%)</label>
          <input
            id="mock-error-rate"
            type="number"
            min="0"
            max="100"
            value={form.errorRate}
            onChange={(e) => patch({ errorRate: e.target.value })}
          />
        </div>
        <div className="form-row">
          <label htmlFor="mock-error-status">Error status</label>
          <input
            id="mock-error-status"
            type="number"
            min="400"
            max="599"
            value={form.errorStatusCode}
            onChange={(e) => patch({ errorStatusCode: e.target.value })}
          />
        </div>
      </div>

      <div className="mock-section">
        <div className="mock-section-title">Response headers</div>
        <KeyValueEditor
          rows={headers}
          onChange={setHeaders}
          keyPlaceholder="Header"
          valuePlaceholder="Value"
        />
        <p className="auth-hint">
          Content-Length, Transfer-Encoding, Connection, Keep-Alive and Upgrade are set by
          the server.
        </p>
      </div>

      <div className="mock-section">
        <div className="mock-section-title">Response body</div>
        <div className="editor-box" style={{ height: 180 }}>
          <CodeEditor value={body} onChange={setBody} language="json" height="100%" />
        </div>
      </div>

      {error && <div className="mock-error" role="alert">{error}</div>}

      <div className="mock-form-actions">
        <button type="submit" className="send-btn" disabled={busy}>
          {busy ? 'Saving…' : editing ? 'Save changes' : 'Create mock'}
        </button>
        <button type="button" className="mini-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
