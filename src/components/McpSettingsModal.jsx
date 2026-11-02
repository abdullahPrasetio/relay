import React, { useCallback, useEffect, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import { MCP_SCOPES, MCP_SCOPE_LABELS } from '../../shared/mcpScopes.js';

const POLL_MS = 2000;
const APPROVALS = [
  ['always', 'Always ask'],
  ['session', 'Ask once per action, then allow for the session'],
  ['never', 'Never ask'],
];

function errorText(res, fallback) {
  const err = res?.error;
  if (typeof err === 'string' && err) return err;
  if (err?.message) return err.message;
  return fallback;
}

function formatLastUsed(at) {
  const value = Number(at);
  if (!at || !Number.isFinite(value)) return 'never';
  const diff = Date.now() - value;
  if (diff < 60_000) return 'just now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

function toggleScope(scopes, scope) {
  return scopes.includes(scope) ? scopes.filter((entry) => entry !== scope) : [...scopes, scope];
}

function httpConfigText(url, token) {
  return JSON.stringify(
    {
      mcpServers: {
        relay: {
          type: 'http',
          url,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    },
    null,
    2
  );
}

function stdioConfigText(stdio, url, token) {
  return JSON.stringify(
    {
      mcpServers: {
        relay: {
          type: 'stdio',
          command: stdio?.command || '',
          args: Array.isArray(stdio?.args) ? stdio.args : [],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            RELAY_MCP_URL: url,
            RELAY_MCP_TOKEN: token,
          },
        },
      },
    },
    null,
    2
  );
}

// Clipboard writes fail outside a secure/user-gesture context; selecting the
// source text keeps the value copyable by hand instead of losing it.
function selectNode(node) {
  if (!node) return;
  if (typeof node.select === 'function') {
    node.focus();
    node.select();
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

function ScopeGrid({ scopes, onChange, testIdPrefix }) {
  return (
    <div className="mcp-scope-grid">
      {MCP_SCOPES.map((scope) => (
        <label key={scope}>
          <input
            type="checkbox"
            data-testid={testIdPrefix ? `${testIdPrefix}-${scope}` : undefined}
            checked={scopes.includes(scope)}
            onChange={() => onChange(scope)}
          />
          <span>
            <span className="mcp-scope-name">{scope}</span>
            <span className="mcp-scope-label">{MCP_SCOPE_LABELS[scope]}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function McpSettingsBody({ api, onClose }) {
  const aliveRef = useRef(true);
  const copyNodes = useRef({});

  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState({ running: false, port: null, url: null, error: '' });
  const [port, setPort] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');
  const [newScopes, setNewScopes] = useState(['read']);
  const [newApproval, setNewApproval] = useState('always');
  const [issued, setIssued] = useState(null);
  const [editing, setEditing] = useState(null);
  const [confirmRevoke, setConfirmRevoke] = useState(null);
  const [copiedKey, setCopiedKey] = useState('');

  const setCopyRef = (key) => (node) => {
    copyNodes.current[key] = node;
  };

  const refreshStatus = useCallback(async () => {
    try {
      const next = await api.status();
      if (aliveRef.current && next) setStatus(next);
    } catch {
      /* transient IPC failure; the next poll retries */
    }
  }, [api]);

  const loadConfig = useCallback(async () => {
    try {
      const next = await api.getConfig();
      if (!aliveRef.current || !next) return;
      setConfig(next);
      if (next.status) setStatus(next.status);
      setPort((current) => (current === '' ? String(next.port ?? '') : current));
    } catch (err) {
      if (aliveRef.current) setError(err?.message || 'Could not load the MCP settings.');
    }
  }, [api]);

  useEffect(() => {
    aliveRef.current = true;
    loadConfig();
    const timer = setInterval(refreshStatus, POLL_MS);
    return () => {
      aliveRef.current = false;
      clearInterval(timer);
    };
  }, [loadConfig, refreshStatus]);

  const copy = async (key, text) => {
    if (!text) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      if (!aliveRef.current) return;
      setCopiedKey(key);
      setTimeout(() => {
        if (aliveRef.current) setCopiedKey((current) => (current === key ? '' : current));
      }, 1500);
    } catch {
      // Fallback: leave the text selected so it can be copied manually.
      selectNode(copyNodes.current[key]);
      setError('Could not copy automatically — the text is selected, press Ctrl/Cmd+C.');
    }
  };

  const runAction = async (fn, fallback) => {
    if (busy) return null;
    setBusy(true);
    setError('');
    try {
      const res = await fn();
      if (!res?.ok) {
        if (aliveRef.current) setError(errorText(res, fallback));
        return null;
      }
      if (res.status && aliveRef.current) setStatus(res.status);
      return res;
    } catch (err) {
      if (aliveRef.current) setError(err?.message || fallback);
      return null;
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const toggleEnabled = async (enabled) => {
    const res = await runAction(() => api.setEnabled(enabled), 'Could not update the MCP server.');
    if (!res) return;
    setConfig((prev) => (prev ? { ...prev, enabled } : prev));
    loadConfig();
  };

  const portNumber = Number(port);
  const portValid = port !== '' && Number.isInteger(portNumber) && portNumber >= 1024 && portNumber <= 65535;

  const savePort = async () => {
    if (!portValid) {
      setError('Port must be a whole number between 1024 and 65535.');
      return;
    }
    const res = await runAction(() => api.setPort(portNumber), 'Could not change the MCP port.');
    if (!res) return;
    setConfig((prev) => (prev ? { ...prev, port: portNumber } : prev));
    loadConfig();
  };

  const createClient = async () => {
    const name = newName.trim();
    if (!name) {
      setError('Give the MCP client a name.');
      return;
    }
    const res = await runAction(
      () => api.createClient({ name, scopes: newScopes, approval: newApproval }),
      'Could not create the MCP client.'
    );
    if (!res) return;
    if (res.token) setIssued({ clientName: res.client?.name || name, token: res.token });
    setNewName('');
    setNewScopes(['read']);
    setNewApproval('always');
    loadConfig();
  };

  const rotateToken = async (client) => {
    const res = await runAction(() => api.rotateToken(client.id), 'Could not rotate the token.');
    if (!res) return;
    if (res.token) setIssued({ clientName: res.client?.name || client.name, token: res.token });
    loadConfig();
  };

  const revokeClient = async (client) => {
    const res = await runAction(() => api.revokeClient(client.id), 'Could not revoke the MCP client.');
    if (!res) return;
    setConfirmRevoke((current) => (current === client.id ? null : current));
    setEditing((current) => (current?.id === client.id ? null : current));
    loadConfig();
  };

  const startEdit = (client) => {
    setError('');
    setConfirmRevoke(null);
    setEditing({
      id: client.id,
      name: client.name || '',
      scopes: Array.isArray(client.scopes) ? [...client.scopes] : [],
      approval: client.approval || 'always',
    });
  };

  const saveEdit = async () => {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) {
      setError('Give the MCP client a name.');
      return;
    }
    const res = await runAction(
      () => api.updateClient({ id: editing.id, name, scopes: editing.scopes, approval: editing.approval }),
      'Could not update the MCP client.'
    );
    if (!res) return;
    setEditing(null);
    loadConfig();
  };

  const clients = status.clients || config?.clients || [];
  const httpUrl = config?.httpUrl || status.url || '';
  const stdio = config?.stdio || { command: '', args: [] };
  const running = !!status.running;
  const currentPort = status.port ?? config?.port ?? '';
  const httpBlock = issued ? httpConfigText(httpUrl, issued.token) : '';
  const stdioBlock = issued ? stdioConfigText(stdio, httpUrl, issued.token) : '';

  return (
    <Modal
      title="MCP server"
      onClose={onClose}
      width={720}
      footer={
        <button type="button" className="mini-btn" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="mcp-settings">
        <section className="mcp-settings-server">
          <div className="mcp-section-title">Server</div>
          <label className="mcp-toggle">
            <input
              type="checkbox"
              data-testid="mcp-enabled"
              checked={!!config?.enabled}
              onChange={(e) => toggleEnabled(e.target.checked)}
              disabled={busy}
            />
            <span>Enable MCP server</span>
          </label>

          <div className="mcp-port-row">
            <div className="form-row">
              <label htmlFor="mcp-port">Port</label>
              <input
                id="mcp-port"
                data-testid="mcp-port"
                type="number"
                min="1024"
                max="65535"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                disabled={busy}
              />
            </div>
            <button
              type="button"
              className="mini-btn"
              onClick={savePort}
              disabled={busy || !portValid || portNumber === config?.port}
            >
              Save port
            </button>
          </div>

          <div className="mcp-status-line">
            <span
              className={`mcp-status ${running ? 'running' : 'stopped'}`}
              data-testid="mcp-status"
            >
              {running ? 'running' : 'stopped'}
            </span>
            <span className="mcp-status-port">port {currentPort || '—'}</span>
          </div>

          {status.error && <p className="mcp-warning">{status.error}</p>}
          {error && (
            <div className="mcp-warning" role="alert">
              {error}
            </div>
          )}

          <div className="mock-url-row">
            <code className="mock-url" data-testid="mcp-http-url">{httpUrl}</code>
            <button
              type="button"
              className="mini-btn"
              onClick={() => copy('http-url', httpUrl)}
              disabled={!httpUrl}
              title="Copy MCP endpoint"
            >
              {copiedKey === 'http-url' ? 'Copied' : 'Copy'}
            </button>
          </div>
        </section>

        {issued && (
          <section className="mcp-token">
            <div className="mcp-section-title">Token for {issued.clientName}</div>
            <p className="mcp-warning">This token is shown only once. Copy it now; it cannot be retrieved later.</p>
            <div className="mcp-token-actions">
              <input
                data-testid="mcp-client-token"
                aria-label="MCP client token"
                readOnly
                value={issued.token}
                ref={setCopyRef('token')}
                onFocus={(e) => e.target.select()}
              />
              <button type="button" className="mini-btn" onClick={() => copy('token', issued.token)}>
                {copiedKey === 'token' ? 'Copied' : 'Copy'}
              </button>
            </div>

            <div className="mcp-config-head">
              <span>HTTP client config</span>
              <button type="button" className="mini-btn" onClick={() => copy('http-config', httpBlock)}>
                {copiedKey === 'http-config' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <pre className="mcp-config" data-testid="mcp-config-http" ref={setCopyRef('http-config')}>{httpBlock}</pre>

            <div className="mcp-config-head">
              <span>stdio client config</span>
              <button type="button" className="mini-btn" onClick={() => copy('stdio-config', stdioBlock)}>
                {copiedKey === 'stdio-config' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <pre className="mcp-config" data-testid="mcp-config-stdio" ref={setCopyRef('stdio-config')}>{stdioBlock}</pre>

            <div className="mcp-token-actions">
              <button type="button" className="mini-btn" onClick={() => setIssued(null)}>
                Clear token
              </button>
            </div>
          </section>
        )}

        <section className="mcp-settings-clients">
          <div className="mcp-section-title">
            Clients <span className="badge">{clients.length}</span>
          </div>

          {clients.length === 0 ? (
            <div className="auth-hint">No MCP clients yet. Create one below to let an AI client connect.</div>
          ) : (
            <ul className="mcp-client-list">
              {clients.map((client) => (
                <li key={client.id} className="mcp-client-row">
                  {editing?.id === client.id ? (
                    <div className="mcp-client-edit">
                      <div className="form-row">
                        <label htmlFor={`mcp-edit-name-${client.id}`}>Name</label>
                        <input
                          id={`mcp-edit-name-${client.id}`}
                          value={editing.name}
                          maxLength={60}
                          onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                          disabled={busy}
                        />
                      </div>
                      <div className="form-row">
                        <label>Scopes</label>
                        <ScopeGrid
                          scopes={editing.scopes}
                          onChange={(scope) =>
                            setEditing({ ...editing, scopes: toggleScope(editing.scopes, scope) })
                          }
                        />
                      </div>
                      <div className="form-row">
                        <label htmlFor={`mcp-edit-approval-${client.id}`}>Approval for non-read actions</label>
                        <select
                          id={`mcp-edit-approval-${client.id}`}
                          value={editing.approval}
                          onChange={(e) => setEditing({ ...editing, approval: e.target.value })}
                          disabled={busy}
                        >
                          {APPROVALS.map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="mcp-client-actions">
                        <button type="button" className="mini-btn primary" onClick={saveEdit} disabled={busy}>
                          Save
                        </button>
                        <button type="button" className="mini-btn" onClick={() => setEditing(null)} disabled={busy}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="mcp-client-main">
                        <div className="mcp-client-head">
                          <strong>{client.name}</strong>
                          <code>{client.prefix}</code>
                        </div>
                        <div className="mcp-client-meta">
                          scopes: {client.scopes?.length ? client.scopes.join(', ') : 'none'}
                        </div>
                        <div className="mcp-client-meta">
                          approval: {client.approval} · last used: {formatLastUsed(client.lastUsedAt)}
                        </div>
                      </div>

                      {confirmRevoke === client.id ? (
                        <div className="mcp-confirm">
                          <span>Revoke “{client.name}”? Its token stops working immediately.</span>
                          <button
                            type="button"
                            className="mini-btn danger"
                            data-testid={`mcp-client-revoke-${client.id}`}
                            onClick={() => revokeClient(client)}
                            disabled={busy}
                          >
                            Confirm revoke
                          </button>
                          <button
                            type="button"
                            className="mini-btn"
                            onClick={() => setConfirmRevoke(null)}
                            disabled={busy}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="mcp-client-actions">
                          <button
                            type="button"
                            className="mini-btn"
                            data-testid={`mcp-client-edit-${client.id}`}
                            onClick={() => startEdit(client)}
                            disabled={busy}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="mini-btn danger"
                            data-testid={`mcp-client-revoke-${client.id}`}
                            onClick={() => setConfirmRevoke(client.id)}
                            disabled={busy}
                          >
                            Revoke
                          </button>
                          <button
                            type="button"
                            className="mini-btn"
                            data-testid={`mcp-client-rotate-${client.id}`}
                            onClick={() => rotateToken(client)}
                            disabled={busy}
                          >
                            Rotate token
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mcp-settings-new">
          <div className="mcp-section-title">New client</div>

          <div className="form-row">
            <label htmlFor="mcp-client-name">Name</label>
            <input
              id="mcp-client-name"
              data-testid="mcp-client-name"
              value={newName}
              maxLength={60}
              placeholder="Claude Desktop"
              onChange={(e) => setNewName(e.target.value)}
              disabled={busy}
            />
          </div>

          <div className="form-row">
            <label>Scopes</label>
            <ScopeGrid
              scopes={newScopes}
              onChange={(scope) => setNewScopes((prev) => toggleScope(prev, scope))}
              testIdPrefix="mcp-scope"
            />
          </div>

          <div className="form-row">
            <label htmlFor="mcp-client-approval">Approval for non-read actions</label>
            <select
              id="mcp-client-approval"
              data-testid="mcp-client-approval"
              value={newApproval}
              onChange={(e) => setNewApproval(e.target.value)}
              disabled={busy}
            >
              {APPROVALS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            className="mini-btn primary"
            data-testid="mcp-create-client"
            onClick={createClient}
            disabled={busy || !newName.trim()}
          >
            Create client
          </button>
        </section>

        <p className="auth-hint">
          Treat an MCP token like a password: it grants every scope you assigned to that client. The server
          listens on loopback only and refuses other hosts and browser origins. Revoking a client or rotating
          its token invalidates the old token immediately. Non-read actions still ask for approval unless the
          client policy is set to <code>never</code>.
        </p>
      </div>
    </Modal>
  );
}

// MCP settings live entirely in the main process, so this modal talks to
// `window.api.mcp` directly instead of reaching into the workspace store.
export default function McpSettingsModal({ onClose }) {
  const api = typeof window !== 'undefined' ? window.api?.mcp : null;

  if (!api) {
    return (
      <Modal title="MCP server" onClose={onClose} width={720}>
        <p className="auth-hint">MCP is only available in the desktop app.</p>
      </Modal>
    );
  }

  return <McpSettingsBody api={api} onClose={onClose} />;
}
