import React, { useMemo, useState } from 'react';

export default function ResponsePanel({ response, sending, testResults, onSaveExample, onSetVariable }) {
  const [tab, setTab] = useState('Body');

  // Right-click a text selection in the response to set it as a variable.
  function onBodyContextMenu(e) {
    if (!onSetVariable) return;
    const sel = window.getSelection?.().toString();
    if (sel && sel.trim()) {
      e.preventDefault();
      onSetVariable(sel);
    }
  }

  if (sending) {
    return (
      <section className="response-panel">
        <div className="response-empty">Sending request…</div>
      </section>
    );
  }

  if (!response) {
    return (
      <section className="response-panel">
        <div className="response-empty">
          Response will appear here. Enter a URL and hit Send.
        </div>
      </section>
    );
  }

  if (!response.ok) {
    return (
      <section className="response-panel">
        <div className="response-status error" data-testid="response-status">
          <span className="status-pill error">Error</span>
          <span className="meta">{response.timeMs} ms</span>
        </div>
        <pre className="response-body error-text">{response.error}</pre>
      </section>
    );
  }

  const passed = (testResults?.results || []).filter((r) => r.passed).length;
  const total = testResults?.results?.length || 0;

  const tabs = ['Body', 'Headers', 'Cookies', 'Request'];
  if (testResults?.ran) tabs.push('Tests');
  if ((response.consoleLogs?.length || 0) > 0) tabs.push('Console');

  return (
    <section className="response-panel">
      <div className="response-status" data-testid="response-status">
        <span className={`status-pill ${statusClass(response.status)}`}>
          {response.status} {response.statusText}
        </span>
        <span className="meta">Time: {response.timeMs} ms</span>
        <span className="meta">Size: {formatBytes(response.size)}</span>
        {response.tlsInsecure && (
          <span className="meta tls-warn" title="This response was fetched without certificate verification">
            TLS verification off
          </span>
        )}
        {testResults?.ran && (
          <span className={`meta tests-summary ${passed === total ? 'all-pass' : 'some-fail'}`}>
            Tests: {passed}/{total} passed
          </span>
        )}
        <div className="status-actions">
          {canSaveResponse() && (
            <button
              className="mini-btn"
              data-testid="response-save"
              title="Save the response body to a file"
              onClick={() => saveBody(response)}
            >
              Save
            </button>
          )}
          {onSaveExample && !response.isBinary && (
            <button
              className="mini-btn"
              title="Save this response as an example"
              onClick={() => onSaveExample(response)}
            >
              Save as Example
            </button>
          )}
        </div>
      </div>

      <div className="tabs">
        {tabs.map((t) => (
          <button
            key={t}
            className={`tab ${tab === t ? 'active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t}
            {t === 'Headers' && <span className="badge">{response.headers.length}</span>}
            {t === 'Cookies' && (response.cookies?.length || 0) > 0 && (
              <span className="badge">{response.cookies.length}</span>
            )}
            {t === 'Tests' && total > 0 && (
              <span className={`badge ${passed === total ? 'ok-badge' : 'fail-badge'}`}>
                {passed}/{total}
              </span>
            )}
            {t === 'Console' && (response.consoleLogs?.length || 0) > 0 && (
              <span className="badge">{response.consoleLogs.length}</span>
            )}
          </button>
        ))}
      </div>

      <div className="tab-content">
        {tab === 'Body' && <ResponseBody response={response} onContextMenu={onBodyContextMenu} />}
        {tab === 'Headers' && <ResponseHeaders headers={response.headers} />}
        {tab === 'Cookies' && <ResponseCookies cookies={response.cookies} />}
        {tab === 'Request' && <SentRequest sent={response.sent} />}
        {tab === 'Tests' && <TestResults results={testResults?.results} />}
        {tab === 'Console' && <ConsoleOutput logs={response.consoleLogs} />}
      </div>
    </section>
  );
}

function ResponseBody({ response, onContextMenu }) {
  const ct = (response.contentType || '').toLowerCase();
  const isHtml = ct.includes('html');
  // Default view: pretty for JSON, preview for HTML, raw otherwise.
  const [view, setView] = useState(isHtml ? 'preview' : 'pretty');

  const pretty = useMemo(() => formatBody(response), [response]);

  // Binary bodies are never decoded: show a safe preview (image/PDF) or a
  // size summary, and let the user save the exact bytes.
  if (response.isBinary) return <BinaryPreview response={response} />;

  const views = ['pretty', 'raw'];
  if (isHtml) views.push('preview');

  return (
    <div className="response-body-wrap">
      <div className="body-view-switch">
        {views.map((v) => (
          <button
            key={v}
            className={`view-chip ${view === v ? 'active' : ''}`}
            onClick={() => setView(v)}
          >
            {v === 'pretty' ? 'Pretty' : v === 'raw' ? 'Raw' : 'Preview'}
          </button>
        ))}
        <span className="body-ct">{response.contentType || 'text/plain'}</span>
      </div>

      {view === 'preview' && isHtml ? (
        <iframe
          className="response-preview"
          title="HTML preview"
          sandbox=""
          srcDoc={response.body || ''}
        />
      ) : (
        <pre
          className="response-body"
          onContextMenu={onContextMenu}
          title="Tip: select text and right-click to set it as a variable"
        >
          {(view === 'raw' ? response.body : pretty) || ''}
        </pre>
      )}
    </div>
  );
}

function BinaryPreview({ response }) {
  const ct = (response.contentType || '').split(';')[0].trim().toLowerCase();
  const size = formatBytes(response.size);

  if (ct.startsWith('image/')) {
    return (
      <div className="response-body-wrap">
        <div className="body-view-switch">
          <span className="body-ct">{response.contentType}</span>
        </div>
        <img
          className="response-image"
          data-testid="response-binary-preview"
          alt="Response preview"
          src={`data:${ct};base64,${response.bodyBase64}`}
        />
      </div>
    );
  }

  if (ct === 'application/pdf') {
    return (
      <div className="response-body-wrap">
        <div className="body-view-switch">
          <span className="body-ct">{response.contentType}</span>
        </div>
        <iframe
          className="response-preview"
          title="PDF preview"
          sandbox=""
          src={`data:application/pdf;base64,${response.bodyBase64}`}
        />
        <p className="auth-hint">
          Binary response ({size}). If the preview is blank, use Save to open it
          externally.
        </p>
      </div>
    );
  }

  return (
    <div className="response-empty">
      Binary response ({size}). Use Save to write the exact bytes to a file.
    </div>
  );
}

function canSaveResponse() {
  return typeof window !== 'undefined' && !!window.api?.saveResponse;
}

// Last path segment of the final URL, sanitized for use as a file name.
function suggestFileName(response) {
  try {
    const last = new URL(response.finalUrl).pathname.split('/').filter(Boolean).pop();
    if (last) return last.replace(/[^\w.-]+/g, '_');
  } catch {
    /* fall through for relative or missing URLs */
  }
  return 'response.bin';
}

async function saveBody(response) {
  if (!canSaveResponse()) return;
  const payload = {
    suggestedName: suggestFileName(response),
    ...(response.isBinary
      ? { base64: response.bodyBase64 }
      : { text: response.body || '' }),
  };
  await window.api.saveResponse(payload);
}

function ResponseHeaders({ headers }) {
  return (
    <table className="kv readonly">
      <tbody>
        {headers.map((h, i) => (
          <tr key={i}>
            <td className="h-key">{h.key}</td>
            <td className="h-val">{h.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ResponseCookies({ cookies }) {
  if (!cookies || cookies.length === 0) {
    return <div className="response-empty">No cookies set by this response.</div>;
  }
  return (
    <table className="kv readonly">
      <thead>
        <tr>
          <th>Name</th>
          <th>Value</th>
          <th>Path</th>
          <th>Flags</th>
        </tr>
      </thead>
      <tbody>
        {cookies.map((c, i) => (
          <tr key={i}>
            <td className="h-key">{c.name}</td>
            <td className="h-val">{c.value}</td>
            <td>{c.path}</td>
            <td>
              {c.httpOnly ? 'HttpOnly ' : ''}
              {c.secure ? 'Secure' : ''}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SentRequest({ sent }) {
  if (!sent) {
    return <div className="response-empty">No request details captured.</div>;
  }
  return (
    <div className="sent-request">
      <div className="sent-line">
        <span className={`method-tag method-${sent.method}`}>{sent.method}</span>
        <span className="sent-url">{sent.url}</span>
      </div>
      <div className="sent-section-title">Headers sent</div>
      <table className="kv readonly">
        <tbody>
          {(sent.headers || []).map((h, i) => (
            <tr key={i}>
              <td className="h-key">{h.key}</td>
              <td className="h-val">{h.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {sent.body ? (
        <>
          <div className="sent-section-title">Body sent</div>
          <pre className="response-body">{sent.body}</pre>
        </>
      ) : (
        <div className="sent-section-title">No body sent</div>
      )}
    </div>
  );
}

function ConsoleOutput({ logs }) {
  if (!logs || logs.length === 0) {
    return <div className="response-empty">No console output. Use console.log(...) in scripts.</div>;
  }
  return (
    <div className="console-output">
      {logs.map((l, i) => (
        <div key={i} className={`console-line level-${l.level}`}>
          <span className="console-level">{l.level}</span>
          <span className="console-text">{l.text}</span>
        </div>
      ))}
    </div>
  );
}

function TestResults({ results }) {
  if (!results || results.length === 0) {
    return <div className="response-empty">No tests defined for this request.</div>;
  }
  return (
    <div className="test-results">
      {results.map((r, i) => (
        <div key={i} className={`test-result ${r.passed ? 'pass' : 'fail'}`}>
          <span className="test-icon">{r.passed ? '✓' : '✕'}</span>
          <span className="test-name">{r.name}</span>
          {!r.passed && r.error && <span className="test-error">{r.error}</span>}
        </div>
      ))}
    </div>
  );
}

function formatBody(response) {
  const ct = (response.contentType || '').toLowerCase();
  if (ct.includes('json')) {
    try {
      return JSON.stringify(JSON.parse(response.body), null, 2);
    } catch {
      return response.body;
    }
  }
  return response.body;
}

function statusClass(status) {
  if (status >= 200 && status < 300) return 'ok';
  if (status >= 300 && status < 400) return 'redirect';
  if (status >= 400) return 'error';
  return '';
}

function formatBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
