import React, { useState } from 'react';
import KeyValueEditor from './KeyValueEditor.jsx';
import AuthPanel from './AuthPanel.jsx';
import VarInput from './VarInput.jsx';
import CodeEditor from './CodeEditor.jsx';
import Icon from './Icon.jsx';
import { computeAutoHeaders } from '../lib/autoHeaders.js';
import { extractPathVars } from '../lib/variables.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const TABS = ['Params', 'Authorization', 'Headers', 'Body', 'Pre-request', 'Tests', 'Examples'];

// Methods that typically carry a body open on the Body tab by default; the
// rest open on Params. (The key prop in App remounts this per request/tab, so
// the initial tab reflects the request's method.)
const BODY_METHODS = ['POST', 'PUT', 'PATCH'];

export default function RequestPanel({
  request,
  onChange,
  onSend,
  onSave,
  onShowCode,
  onSetVariable,
  onOpenSettings,
  onAbort,
  sending,
  dirty,
}) {
  const [tab, setTab] = useState(() =>
    BODY_METHODS.includes((request.method || 'GET').toUpperCase()) ? 'Body' : 'Params'
  );

  const patch = (p) => onChange({ ...request, ...p });

  function onKeyDown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      // While a request is in flight the shortcut must not queue another one.
      if (!sending) onSend();
    }
  }

  const authActive =
    request.auth && request.auth.type !== 'none' && request.auth.type !== 'inherit';
  // (oauth2 counts as active too — covered by the type !== none/inherit check)

  return (
    <section className="request-panel" onKeyDown={onKeyDown}>
      <RequestNameBar request={request} onRename={(name) => patch({ name })} />
      <div className="url-bar">
        <select
          className={`method method-${request.method}`}
          value={request.method}
          onChange={(e) => patch({ method: e.target.value })}
        >
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <VarInput
          className="url-input"
          placeholder="Enter URL, e.g. https://api.github.com/users/postmanlabs"
          value={request.url}
          onChange={(v) => patch({ url: v })}
        />
        {sending ? (
          <button className="send-btn stop-btn" data-testid="stop-button" onClick={onAbort}>
            Stop
          </button>
        ) : (
          <button className="send-btn" onClick={onSend}>
            Send
          </button>
        )}
        <button className="save-btn" onClick={onSave} title={dirty ? 'Unsaved changes — Save (Cmd/Ctrl+S)' : 'Saved'}>
          Save
          {dirty && <span className="dirty-dot" aria-label="unsaved changes" />}
        </button>
        <button
          className="save-btn icon-only"
          onClick={onOpenSettings}
          title="Request settings"
          data-testid="request-settings-open"
        >
          <Icon name="gear" size={16} />
        </button>
        <button className="save-btn icon-only" onClick={onShowCode} title="Generate code">
          <Icon name="code" size={16} />
        </button>
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t}
            className={`tab ${tab === t ? 'active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t}
            {t === 'Params' && countEnabled(request.params) > 0 && (
              <span className="badge">{countEnabled(request.params)}</span>
            )}
            {t === 'Headers' && countEnabled(request.headers) > 0 && (
              <span className="badge">{countEnabled(request.headers)}</span>
            )}
            {t === 'Authorization' && authActive && <span className="dot" />}
            {t === 'Body' && request.body?.mode !== 'none' && <span className="dot" />}
            {t === 'Pre-request' && request.preRequest?.trim() && <span className="dot" />}
            {t === 'Tests' && request.tests?.trim() && <span className="dot" />}
            {t === 'Examples' && (request.examples?.length || 0) > 0 && (
              <span className="badge">{request.examples.length}</span>
            )}
          </button>
        ))}
      </div>

      <div className="tab-content">
        {tab === 'Params' && (
          <ParamsTab request={request} patch={patch} />
        )}
        {tab === 'Authorization' && (
          <AuthPanel auth={request.auth} onChange={(auth) => patch({ auth })} allowInherit />
        )}
        {tab === 'Headers' && (
          <HeadersEditor request={request} onChange={(headers) => patch({ headers })} />
        )}
        {tab === 'Body' && (
          <BodyEditor body={request.body} onChange={(body) => patch({ body })} />
        )}
        {tab === 'Pre-request' && (
          <PreRequestEditor
            value={request.preRequest || ''}
            onChange={(preRequest) => patch({ preRequest })}
          />
        )}
        {tab === 'Tests' && (
          <TestsEditor value={request.tests || ''} onChange={(tests) => patch({ tests })} />
        )}
        {tab === 'Examples' && (
          <ExamplesList
            examples={request.examples || []}
            onDelete={(id) => patch({ examples: request.examples.filter((e) => e.id !== id) })}
          />
        )}
      </div>
    </section>
  );
}

function ExamplesList({ examples, onDelete }) {
  const [openId, setOpenId] = useState(null);
  if (examples.length === 0) {
    return (
      <p className="auth-hint">
        No examples yet. Send a request, then click “Save as Example” in the response.
      </p>
    );
  }
  const open = examples.find((e) => e.id === openId);
  return (
    <div className="examples-list">
      {examples.map((ex) => (
        <div key={ex.id} className="example-row">
          <button
            className="example-name"
            onClick={() => setOpenId(openId === ex.id ? null : ex.id)}
          >
<Icon name={openId === ex.id ? 'chevronDown' : 'chevronRight'} size={13} /> {ex.name}
            <span className={`status-pill ${ex.response.status < 400 ? 'ok' : 'error'}`}>
              {ex.response.status}
            </span>
          </button>
          <button className="icon-btn" title="Delete example" onClick={() => onDelete(ex.id)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
      {open && (
        <pre className="response-body" style={{ marginTop: 10 }}>
          {formatExampleBody(open.response)}
        </pre>
      )}
    </div>
  );
}

function formatExampleBody(response) {
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

// Breadcrumb-style editable request name, like Postman's title above the URL.
function RequestNameBar({ request, onRename }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const name = request.name && request.name.trim() ? request.name : 'Untitled Request';

  function begin() {
    setDraft(name === 'Untitled Request' ? '' : name);
    setEditing(true);
  }
  function commit() {
    onRename(draft.trim() || 'Untitled Request');
    setEditing(false);
  }

  return (
    <div className="req-namebar">
      <span className={`method-tag method-${request.method}`}>{request.method}</span>
      {editing ? (
        <input
          className="req-name-input"
          autoFocus
          value={draft}
          placeholder="Request name"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <span className="req-name" title="Click to rename" onClick={begin}>
          {name}
          <span className="req-name-edit"><Icon name="edit" size={13} /></span>
        </span>
      )}
    </div>
  );
}

function HeadersEditor({ request, onChange }) {
  const [showAuto, setShowAuto] = useState(true);
  const auto = computeAutoHeaders(request);
  return (
    <div>
      <KeyValueEditor
        rows={request.headers || []}
        onChange={onChange}
        keyPlaceholder="Header"
      />
      <div className="auto-headers">
        <button className="auto-headers-toggle" onClick={() => setShowAuto((v) => !v)}>
<Icon name={showAuto ? 'chevronDown' : 'chevronRight'} size={12} /> {auto.length} auto-generated header{auto.length === 1 ? '' : 's'}
        </button>
        {showAuto && (
          <table className="kv readonly auto">
            <tbody>
              {auto.map((h, i) => (
                <tr key={i}>
                  <td className="h-key">{h.key}</td>
                  <td className="h-val">{h.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const BODY_MODES = [
  { id: 'none', label: 'None' },
  { id: 'raw', label: 'Raw' },
  { id: 'json', label: 'JSON' },
  { id: 'form-urlencoded', label: 'x-www-form-urlencoded' },
  { id: 'form-data', label: 'Form Data' },
  { id: 'graphql', label: 'GraphQL' },
];

function BodyEditor({ body, onChange }) {
  const b = body || { mode: 'none', raw: '', form: [] };
  const isForm = b.mode === 'form-urlencoded' || b.mode === 'form-data';
  return (
    <div className="body-editor">
      <div className="body-modes">
        {BODY_MODES.map((mode) => (
          <label key={mode.id} className="radio">
            <input
              type="radio"
              name="bodymode"
              checked={b.mode === mode.id}
              onChange={() => onChange({ ...b, mode: mode.id })}
            />
            {mode.label}
          </label>
        ))}
      </div>
      {(b.mode === 'raw' || b.mode === 'json') && (
        <>
          {b.mode === 'json' && (
            <div className="body-toolbar">
              <button
                className="mini-btn"
                title="Format JSON"
                onClick={() => {
                  try {
                    onChange({ ...b, raw: JSON.stringify(JSON.parse(b.raw || ''), null, 2) });
                  } catch {
                    /* leave invalid JSON as-is */
                  }
                }}
              >
                Beautify
              </button>
            </div>
          )}
          <div className="editor-box">
            <CodeEditor
              language={b.mode === 'json' ? 'json' : 'plaintext'}
              value={b.raw || ''}
              onChange={(v) => onChange({ ...b, raw: v })}
            />
          </div>
        </>
      )}
      {b.mode === 'form-urlencoded' && (
        <KeyValueEditor
          rows={b.form || []}
          onChange={(form) => onChange({ ...b, form })}
          keyPlaceholder="Field"
        />
      )}
      {b.mode === 'form-data' && (
        <FormDataEditor rows={b.form || []} onChange={(form) => onChange({ ...b, form })} />
      )}
      {b.mode === 'graphql' && (
        <GraphQLEditor
          graphql={b.graphql || { query: '', variables: '' }}
          onChange={(graphql) => onChange({ ...b, graphql })}
        />
      )}
    </div>
  );
}

function PreRequestEditor({ value, onChange }) {
  return (
    <div className="tests-editor">
      <div className="editor-box">
        <CodeEditor language="javascript" value={value} onChange={onChange} />
      </div>
      <p className="auth-hint">
        Runs before sending. Use <code>pm.environment.set</code>,{' '}
        <code>pm.collectionVariables.set</code>, <code>pm.variables.get</code>,{' '}
        <code>require('crypto-js'|'moment'|'uuid')</code>.
      </p>
    </div>
  );
}

function TestsEditor({ value, onChange }) {
  return (
    <div className="tests-editor">
      <div className="editor-box">
        <CodeEditor language="javascript" value={value} onChange={onChange} />
      </div>
      <p className="auth-hint">
        Supports a subset of <code>pm.test</code>, <code>pm.expect</code>, and{' '}
        <code>pm.response</code>. Runs after each response.
      </p>
    </div>
  );
}

// Params tab: query params plus a Path Variables table that auto-syncs with
// the :segments present in the URL (like Postman).
function ParamsTab({ request, patch }) {
  const names = extractPathVars(request.url);
  // Keep existing values; add rows for new names; drop rows no longer in URL.
  const existing = request.pathVars || [];
  const pathRows = names.map(
    (name) => existing.find((p) => p.key === name) || { key: name, value: '' }
  );

  function updatePathVar(name, value) {
    const next = names.map((n) => {
      const cur = existing.find((p) => p.key === n) || { key: n, value: '' };
      return n === name ? { ...cur, value } : cur;
    });
    patch({ pathVars: next });
  }

  return (
    <div>
      {names.length > 0 && (
        <div className="path-vars">
          <div className="sent-section-title">Path Variables</div>
          <table className="kv">
            <thead>
              <tr>
                <th>Variable</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {pathRows.map((row) => (
                <tr key={row.key}>
                  <td className="h-key">:{row.key}</td>
                  <td>
                    <VarInput
                      value={row.value}
                      placeholder={`Value for :${row.key}`}
                      onChange={(v) => updatePathVar(row.key, v)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="sent-section-title" style={{ marginTop: names.length ? 14 : 0 }}>
        Query Params
      </div>
      <KeyValueEditor
        rows={request.params || []}
        onChange={(params) => patch({ params })}
        keyPlaceholder="Parameter"
      />
    </div>
  );
}

// GraphQL body: a Query editor + a JSON Variables editor. Sent as JSON
// { query, variables }.
function GraphQLEditor({ graphql, onChange }) {
  const g = graphql || { query: '', variables: '' };
  return (
    <div className="graphql-editor">
      <div className="sent-section-title">Query</div>
      <div className="editor-box" style={{ height: 200 }}>
        <CodeEditor
          language="plaintext"
          value={g.query || ''}
          onChange={(v) => onChange({ ...g, query: v })}
        />
      </div>
      <div className="sent-section-title" style={{ marginTop: 10 }}>
        GraphQL Variables (JSON)
      </div>
      <div className="editor-box" style={{ height: 120 }}>
        <CodeEditor
          language="json"
          value={g.variables || ''}
          onChange={(v) => onChange({ ...g, variables: v })}
        />
      </div>
      <p className="auth-hint">
        Sent as <code>{'{ "query": ..., "variables": ... }'}</code> with Content-Type
        application/json.
      </p>
    </div>
  );
}

// Form-data editor: each row is a text field or a file upload.
function FormDataEditor({ rows, onChange }) {
  const display = [...rows, { key: '', value: '', type: 'text', enabled: true }];
  const hasBridge = typeof window !== 'undefined' && !!window.api?.pickFile;

  function update(index, patch) {
    const next = [...rows];
    if (index === rows.length) next.push({ key: '', value: '', type: 'text', enabled: true, ...patch });
    else next[index] = { ...next[index], ...patch };
    onChange(next);
  }
  function remove(index) {
    onChange(rows.filter((_, i) => i !== index));
  }
  async function chooseFile(index) {
    if (!hasBridge) return;
    const picked = await window.api.pickFile();
    if (picked) update(index, { type: 'file', filePath: picked.filePath, fileName: picked.fileName, size: picked.size });
  }

  return (
    <table className="kv">
      <thead>
        <tr>
          <th className="kv-check"></th>
          <th>Key</th>
          <th>Type</th>
          <th>Value</th>
          <th className="kv-actions"></th>
        </tr>
      </thead>
      <tbody>
        {display.map((row, i) => {
          const isPhantom = i === rows.length;
          return (
            <tr key={i} className={isPhantom ? 'phantom' : ''}>
              <td className="kv-check">
                <input
                  type="checkbox"
                  checked={row.enabled !== false}
                  disabled={isPhantom}
                  onChange={(e) => update(i, { enabled: e.target.checked })}
                />
              </td>
              <td>
                <VarInput value={row.key} placeholder="Field" onChange={(v) => update(i, { key: v })} />
              </td>
              <td className="fd-type">
                <select
                  value={row.type || 'text'}
                  onChange={(e) => update(i, { type: e.target.value, ...(e.target.value === 'text' ? { filePath: undefined, fileName: undefined } : {}) })}
                >
                  <option value="text">Text</option>
                  <option value="file">File</option>
                </select>
              </td>
              <td>
                {row.type === 'file' ? (
                  <div className="fd-file">
                    <button className="mini-btn" onClick={() => chooseFile(i)} disabled={isPhantom && !hasBridge}>
                      {row.fileName ? row.fileName : 'Choose file…'}
                    </button>
                    {row.size != null && row.fileName && (
                      <span className="meta">{formatBytes(row.size)}</span>
                    )}
                  </div>
                ) : (
                  <VarInput value={row.value} placeholder="Value" onChange={(v) => update(i, { value: v })} />
                )}
              </td>
              <td className="kv-actions">
                {!isPhantom && (
                  <button className="icon-btn" title="Remove" onClick={() => remove(i)}>
                    <Icon name="close" size={14} />
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function countEnabled(rows) {
  return (rows || []).filter((r) => r.enabled !== false && r.key).length;
}
