import React, { useEffect, useMemo, useRef, useState } from 'react';
import CodeEditor from './CodeEditor.jsx';
import JsonTree from './JsonTree.jsx';
import {
  detectLanguage,
  escapeHtml,
  findMatches,
  highlightSegments,
  parseJsonBody,
  prettyText,
} from '../lib/responseFormat.js';
import '../styles/response.css';

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

      <ResponseMeta response={response} />

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

      <div className="tab-content response-tab-content">
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
  const parsedJson = useMemo(
    () => (response.isBinary ? { ok: false, value: null } : parseJsonBody(response.body)),
    [response.isBinary, response.body]
  );
  const isJson = parsedJson.ok;

  // Default view: preview for HTML, Pretty for JSON, Raw otherwise. Raw keeps
  // the plain `.response-body` text node that existing e2e assertions read.
  const [view, setView] = useState(isHtml ? 'preview' : isJson ? 'pretty' : 'raw');
  const [findQuery, setFindQuery] = useState('');
  const [findIndex, setFindIndex] = useState(0);
  const copy = useCopy();

  // A new response invalidates both the find results and the chosen view.
  useEffect(() => {
    setView(isHtml ? 'preview' : isJson ? 'pretty' : 'raw');
    setFindQuery('');
    setFindIndex(0);
  }, [response, isHtml, isJson]);

  const pretty = useMemo(
    () => (response.isBinary ? '' : prettyText(response.contentType, response.body)),
    [response.contentType, response.body, response.isBinary]
  );
  const language = useMemo(
    () => detectLanguage(response.contentType, response.body),
    [response.contentType, response.body]
  );
  const matches = useMemo(
    () => findMatches(response.body || '', findQuery),
    [response.body, findQuery]
  );
  const segments = useMemo(
    () => highlightSegments(response.body || '', findQuery, findIndex),
    [response.body, findQuery, findIndex]
  );

  if (response.isBinary) return <BinaryPreview response={response} />;

  const views = ['pretty', 'raw'];
  if (isJson) views.push('tree');
  if (isHtml) views.push('preview');

  const activeMatch = matches.length
    ? ((findIndex % matches.length) + matches.length) % matches.length
    : 0;
  const canFind = view !== 'preview' && view !== 'tree';

  function step(delta) {
    if (matches.length === 0) return;
    setFindIndex((i) => {
      const next = (i + delta) % matches.length;
      return next < 0 ? next + matches.length : next;
    });
  }

  function onFindChange(value) {
    setFindQuery(value);
    setFindIndex(0);
    // Highlights only exist in the Raw text view; jump there while searching.
    if (value && view === 'pretty') setView('raw');
  }

  const rawHtml = segments
    .map((segment) => {
      const safe = escapeHtml(segment.text);
      if (!segment.match) return safe;
      return segment.current
        ? `<mark class="find-current">${safe}</mark>`
        : `<mark class="find-match">${safe}</mark>`;
    })
    .join('');

  return (
    <div className="response-body-wrap">
      <div className="body-view-switch">
        {views.map((v) => (
          <button
            key={v}
            className={`view-chip ${view === v ? 'active' : ''}`}
            onClick={() => setView(v)}
          >
            {v === 'pretty' ? 'Pretty' : v === 'raw' ? 'Raw' : v === 'tree' ? 'Tree' : 'Preview'}
          </button>
        ))}
        <span className="body-ct">{response.contentType || 'text/plain'}</span>

        <div className="body-tools">
          {canFind && (
            <>
              <input
                className="find-input"
                data-testid="response-find"
                type="text"
                value={findQuery}
                placeholder="Find"
                aria-label="Find in response"
                onChange={(e) => onFindChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    step(e.shiftKey ? -1 : 1);
                  }
                }}
              />
              <span className="find-count" data-testid="response-find-count">
                {findQuery ? `${matches.length ? activeMatch + 1 : 0}/${matches.length}` : ''}
              </span>
              <button
                className="mini-btn"
                disabled={matches.length === 0}
                onClick={() => step(-1)}
                title="Previous match"
              >
                Prev
              </button>
              <button
                className="mini-btn"
                disabled={matches.length === 0}
                onClick={() => step(1)}
                title="Next match"
              >
                Next
              </button>
            </>
          )}
          <button
            className="mini-btn"
            data-testid="response-copy-body"
            onClick={() => copy.copy(response.body || '')}
          >
            {copy.copied ? 'Copied' : 'Copy body'}
          </button>
        </div>
      </div>

      {view === 'preview' && isHtml ? (
        <iframe
          className="response-preview"
          title="HTML preview"
          sandbox=""
          srcDoc={response.body || ''}
        />
      ) : view === 'tree' && isJson ? (
        <JsonTree data={parsedJson.value} />
      ) : view === 'raw' ? (
        <pre
          className="response-body"
          onContextMenu={onContextMenu}
          title="Tip: select text and right-click to set it as a variable"
          dangerouslySetInnerHTML={{ __html: rawHtml }}
        />
      ) : (
        <div className="response-editor">
          <CodeEditor value={pretty} language={language} readOnly height="100%" />
        </div>
      )}
    </div>
  );
}

function ResponseMeta({ response }) {
  const redirects = response.redirects || [];
  const t = response.timings || null;
  const items = t
    ? [
        ['Socket', t.socketMs],
        ['DNS', t.dnsMs],
        ['Connect', t.connectMs],
        ['TLS', t.tlsMs],
        ['TTFB', t.ttfbMs],
        ['Total', t.totalMs],
      ].filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
    : [];

  if (redirects.length === 0 && items.length === 0) return null;

  return (
    <div className="response-meta">
      {redirects.length > 0 && (
        <div className="redirect-chain" data-testid="redirect-chain">
          <span className="meta-label">Redirects</span>
          {redirects.map((hop, i) => (
            <span className="redirect-hop" key={`${hop.from}-${i}`}>
              <span className={`status-pill ${statusClass(hop.status)}`}>{hop.status}</span>
              <span className="redirect-target" title={hop.from}>
                {hop.to}
              </span>
              {i < redirects.length - 1 && <span className="redirect-arrow">→</span>}
            </span>
          ))}
        </div>
      )}
      {items.length > 0 && (
        <div className="timing-breakdown" data-testid="timing-breakdown">
          <span className="meta-label">Timing</span>
          {items.map(([label, value]) => (
            <span className="timing-item" key={label}>
              <span className="timing-label">{label}</span>
              <span className="timing-value">{formatMs(value)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function formatMs(value) {
  return `${Math.max(0, Math.round(value))} ms`;
}

function BinaryPreview({ response }) {
  const copy = useCopy();
  const ct = (response.contentType || '').split(';')[0].trim().toLowerCase();
  const size = formatBytes(response.size);

  if (ct.startsWith('image/')) {
    return (
      <div className="response-body-wrap">
        <div className="body-view-switch">
          <span className="body-ct">{response.contentType}</span>
          <button
            className="mini-btn"
            data-testid="response-copy-body"
            onClick={() => copy.copy(response.bodyBase64 || '')}
          >
            {copy.copied ? 'Copied' : 'Copy base64'}
          </button>
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
          <button
            className="mini-btn"
            data-testid="response-copy-body"
            onClick={() => copy.copy(response.bodyBase64 || '')}
          >
            {copy.copied ? 'Copied' : 'Copy base64'}
          </button>
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
  const copy = useCopy();
  const text = headers.map((h) => `${h.key}: ${h.value}`).join('\n');
  return (
    <div className="headers-view">
      <div className="body-toolbar">
        <button
          className="mini-btn"
          data-testid="response-copy-headers"
          onClick={() => copy.copy(text)}
        >
          {copy.copied ? 'Copied' : 'Copy all'}
        </button>
      </div>
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
    </div>
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

// Clipboard helper with an execCommand fallback for environments where the
// async Clipboard API is unavailable or denied.
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the textarea fallback */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

function useCopy() {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy(text) {
    const ok = await copyText(text);
    if (!ok) return;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1400);
  }

  return { copied, copy };
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
