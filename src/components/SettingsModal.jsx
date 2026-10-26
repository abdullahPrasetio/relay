import React, { useState } from 'react';
import Modal from './Modal.jsx';
import Icon from './Icon.jsx';

// App-level network settings: proxy profiles, timeouts, redirect/TLS policy and
// response size limits. Secrets (proxy passwords, client-cert passphrase) are
// write-only here: the main process encrypts them, and we only learn whether
// one is stored (`hasPassword` / `hasClientCertPassphrase`).
const MB = 1024 * 1024;

function newProxyId() {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `px_${uuid}`;
}

function splitBypass(text) {
  return String(text || '')
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function toDraft(settings) {
  const s = settings || {};
  return {
    proxyMode: s.proxyMode || 'none',
    activeProxyId: s.activeProxyId || '',
    timeoutMs: String(s.timeoutMs ?? ''),
    followRedirects: s.followRedirects !== false,
    maxRedirects: String(s.maxRedirects ?? ''),
    verifyTls: s.verifyTls !== false,
    maxResponseMB: String(Number(s.maxResponseBytes ?? 52428800) / MB),
    customCaPath: s.customCaPath || '',
    clientCertPath: s.clientCertPath || '',
    clientKeyPath: s.clientKeyPath || '',
    servername: s.servername || '',
    clientCertPassphrase: '',
    clearClientCertPassphrase: false,
    hasClientCertPassphrase: !!s.hasClientCertPassphrase,
    proxies: (s.proxies || []).map((p) => ({
      id: p.id,
      name: p.name || '',
      protocol: p.protocol || 'http',
      host: p.host || '',
      port: String(p.port ?? ''),
      username: p.username || '',
      password: '',
      clearPassword: false,
      hasPassword: !!p.hasPassword,
      bypassText: (p.bypass || []).join(', '),
    })),
  };
}

function parseIntStrict(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return NaN;
  return Number(text);
}

// Returns an error message, or '' when the draft is valid.
function validateDraft(d) {
  const timeout = parseIntStrict(d.timeoutMs);
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 3600000) {
    return 'Timeout must be a whole number between 1 and 3600000 ms.';
  }
  const maxRedirects = parseIntStrict(d.maxRedirects);
  if (!Number.isFinite(maxRedirects) || maxRedirects < 0 || maxRedirects > 50) {
    return 'Max redirects must be a whole number between 0 and 50.';
  }
  const mb = Number(d.maxResponseMB);
  if (!Number.isFinite(mb) || mb <= 0) {
    return 'Max response size must be a positive number of megabytes.';
  }
  for (const p of d.proxies) {
    const port = parseIntStrict(p.port);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      return `Proxy “${p.name || 'unnamed'}” needs a port between 1 and 65535.`;
    }
  }
  return '';
}

function buildPayload(d) {
  return {
    proxyMode: d.proxyMode,
    activeProxyId: d.proxyMode === 'manual' ? d.activeProxyId || null : null,
    timeoutMs: parseIntStrict(d.timeoutMs),
    followRedirects: d.followRedirects,
    maxRedirects: parseIntStrict(d.maxRedirects),
    verifyTls: d.verifyTls,
    maxResponseBytes: Math.round(Number(d.maxResponseMB) * MB),
    customCaPath: d.customCaPath,
    clientCertPath: d.clientCertPath,
    clientKeyPath: d.clientKeyPath,
    servername: d.servername,
    proxies: d.proxies.map((p) => {
      const out = {
        id: p.id,
        name: p.name,
        protocol: p.protocol,
        host: p.host,
        port: parseIntStrict(p.port),
        username: p.username,
        bypass: splitBypass(p.bypassText),
      };
      if (p.clearPassword) out.clearPassword = true;
      else if (p.password) out.password = p.password;
      return out;
    }),
    ...(d.clearClientCertPassphrase
      ? { clearClientCertPassphrase: true }
      : d.clientCertPassphrase
        ? { clientCertPassphrase: d.clientCertPassphrase }
        : {}),
  };
}

export default function SettingsModal({ settings, onSave, onClose }) {
  const [draft, setDraft] = useState(() => toDraft(settings));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const set = (patch) => setDraft((prev) => ({ ...prev, ...patch }));
  const setProxy = (id, patch) =>
    setDraft((prev) => ({
      ...prev,
      proxies: prev.proxies.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }));

  function addProxy() {
    const id = newProxyId();
    setDraft((prev) => ({
      ...prev,
      proxies: [
        ...prev.proxies,
        {
          id,
          name: `Proxy ${prev.proxies.length + 1}`,
          protocol: 'http',
          host: '',
          port: '8080',
          username: '',
          password: '',
          clearPassword: false,
          hasPassword: false,
          bypassText: '',
        },
      ],
      activeProxyId: prev.activeProxyId || id,
    }));
  }

  function removeProxy(id) {
    setDraft((prev) => ({
      ...prev,
      proxies: prev.proxies.filter((p) => p.id !== id),
      activeProxyId: prev.activeProxyId === id ? '' : prev.activeProxyId,
    }));
  }

  async function pick(field) {
    if (!window.api?.pickFile) return;
    try {
      const res = await window.api.pickFile();
      if (!res || !res.filePath) return; // cancelled: keep current path
      set({ [field]: res.filePath });
    } catch (err) {
      setError(err?.message || 'Could not pick a file.');
    }
  }

  async function submit() {
    const problem = validateDraft(draft);
    if (problem) {
      setError(problem);
      return;
    }
    setError('');
    setSaving(true);
    try {
      await onSave(buildPayload(draft));
      onClose();
    } catch (err) {
      setError(err?.message || 'Failed to save network settings.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title="Network settings"
      onClose={onClose}
      width={760}
      footer={
        <>
          <button className="mini-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="send-btn"
            data-testid="settings-save"
            onClick={submit}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      {error && (
        <p className="auth-hint settings-error" data-testid="settings-error">
          {error}
        </p>
      )}

      <div className="settings-section">Request defaults</div>
      <div className="settings-grid">
        <div className="form-row">
          <label htmlFor="settings-timeout">Default timeout (ms)</label>
          <input
            id="settings-timeout"
            data-testid="settings-timeout"
            type="number"
            min="1"
            max="3600000"
            value={draft.timeoutMs}
            onChange={(e) => set({ timeoutMs: e.target.value })}
          />
        </div>
        <div className="form-row">
          <label htmlFor="settings-max-redirects">Max redirects</label>
          <input
            id="settings-max-redirects"
            data-testid="settings-max-redirects"
            type="number"
            min="0"
            max="50"
            value={draft.maxRedirects}
            onChange={(e) => set({ maxRedirects: e.target.value })}
          />
        </div>
        <div className="form-row">
          <label htmlFor="settings-max-response-mb">Max response size (MB)</label>
          <input
            id="settings-max-response-mb"
            data-testid="settings-max-response-mb"
            type="number"
            min="0.001"
            step="1"
            value={draft.maxResponseMB}
            onChange={(e) => set({ maxResponseMB: e.target.value })}
          />
        </div>
      </div>
      <div className="settings-checks">
        <label className="settings-check">
          <input
            type="checkbox"
            data-testid="settings-follow-redirects"
            checked={draft.followRedirects}
            onChange={(e) => set({ followRedirects: e.target.checked })}
          />
          Follow redirects
        </label>
        <label className="settings-check">
          <input
            type="checkbox"
            data-testid="settings-verify-tls"
            checked={draft.verifyTls}
            onChange={(e) => set({ verifyTls: e.target.checked })}
          />
          Verify TLS certificates
        </label>
      </div>

      <div className="settings-section">Proxy</div>
      <div className="settings-grid">
        <div className="form-row">
          <label htmlFor="settings-proxy-mode">Mode</label>
          <select
            id="settings-proxy-mode"
            data-testid="settings-proxy-mode"
            value={draft.proxyMode}
            onChange={(e) => set({ proxyMode: e.target.value })}
          >
            <option value="none">No proxy</option>
            <option value="environment">From environment (HTTP(S)_PROXY)</option>
            <option value="manual">Manual profile</option>
          </select>
        </div>
        <div className="form-row">
          <label htmlFor="settings-active-proxy">Active profile</label>
          <select
            id="settings-active-proxy"
            data-testid="settings-active-proxy"
            value={draft.activeProxyId}
            disabled={draft.proxyMode !== 'manual'}
            onChange={(e) => set({ activeProxyId: e.target.value })}
          >
            <option value="">— none —</option>
            {draft.proxies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name || 'Proxy'}
              </option>
            ))}
          </select>
        </div>
      </div>

      {draft.proxies.length === 0 && (
        <p className="auth-hint">No proxy profiles yet.</p>
      )}

      {draft.proxies.map((p) => (
        <div className="proxy-card" key={p.id}>
          <div className="proxy-card-head">
            <input
              className="proxy-name"
              data-testid="settings-proxy-name"
              value={p.name}
              placeholder="Profile name"
              onChange={(e) => setProxy(p.id, { name: e.target.value })}
            />
            <button
              className="icon-btn"
              title="Remove profile"
              data-testid="settings-proxy-remove"
              onClick={() => removeProxy(p.id)}
            >
              <Icon name="trash" size={14} />
            </button>
          </div>
          <div className="proxy-grid">
            <div className="form-row">
              <label>Protocol</label>
              <select
                value={p.protocol}
                onChange={(e) => setProxy(p.id, { protocol: e.target.value })}
              >
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
                <option value="socks5">SOCKS5</option>
              </select>
            </div>
            <div className="form-row">
              <label>Host</label>
              <input
                value={p.host}
                placeholder="proxy.example.com"
                onChange={(e) => setProxy(p.id, { host: e.target.value })}
              />
            </div>
            <div className="form-row">
              <label>Port</label>
              <input
                type="number"
                min="1"
                max="65535"
                value={p.port}
                onChange={(e) => setProxy(p.id, { port: e.target.value })}
              />
            </div>
            <div className="form-row">
              <label>Username</label>
              <input
                value={p.username}
                onChange={(e) => setProxy(p.id, { username: e.target.value })}
              />
            </div>
            <div className="form-row">
              <label>Password</label>
              <input
                type="password"
                value={p.password}
                placeholder={p.hasPassword ? '•••• (unchanged)' : ''}
                onChange={(e) => setProxy(p.id, { password: e.target.value })}
              />
            </div>
            <div className="form-row">
              <label>Bypass hosts</label>
              <input
                value={p.bypassText}
                placeholder="localhost, *.internal"
                onChange={(e) => setProxy(p.id, { bypassText: e.target.value })}
              />
            </div>
          </div>
          {p.hasPassword && (
            <label className="settings-check">
              <input
                type="checkbox"
                checked={p.clearPassword}
                onChange={(e) => setProxy(p.id, { clearPassword: e.target.checked })}
              />
              Clear saved password
            </label>
          )}
        </div>
      ))}

      <button className="mini-btn" onClick={addProxy} data-testid="settings-proxy-add">
        <Icon name="plus" size={13} /> Add proxy profile
      </button>

      <div className="settings-section">TLS</div>
      <PathRow
        label="Custom CA certificate"
        value={draft.customCaPath}
        onPick={() => pick('customCaPath')}
        onClear={() => set({ customCaPath: '' })}
      />
      <PathRow
        label="Client certificate"
        value={draft.clientCertPath}
        onPick={() => pick('clientCertPath')}
        onClear={() => set({ clientCertPath: '' })}
      />
      <PathRow
        label="Client private key"
        value={draft.clientKeyPath}
        onPick={() => pick('clientKeyPath')}
        onClear={() => set({ clientKeyPath: '' })}
      />
      <div className="form-row">
        <label htmlFor="settings-servername">TLS server name (SNI)</label>
        <input
          id="settings-servername"
          data-testid="settings-servername"
          placeholder="Auto (from the request URL)"
          value={draft.servername}
          onChange={(e) => set({ servername: e.target.value })}
        />
      </div>
      <div className="form-row">
        <label htmlFor="settings-client-passphrase">Client key passphrase</label>
        <input
          id="settings-client-passphrase"
          type="password"
          value={draft.clientCertPassphrase}
          placeholder={draft.hasClientCertPassphrase ? '•••• (unchanged)' : ''}
          onChange={(e) => set({ clientCertPassphrase: e.target.value })}
        />
      </div>
      {draft.hasClientCertPassphrase && (
        <label className="settings-check">
          <input
            type="checkbox"
            checked={draft.clearClientCertPassphrase}
            onChange={(e) => set({ clearClientCertPassphrase: e.target.checked })}
          />
          Clear saved passphrase
        </label>
      )}
    </Modal>
  );
}

function PathRow({ label, value, onPick, onClear }) {
  return (
    <div className="form-row">
      <label>{label}</label>
      <div className="path-row">
        <input value={value} readOnly placeholder="No file selected" />
        <button className="mini-btn" onClick={onPick}>
          Choose…
        </button>
        <button className="mini-btn" onClick={onClear} disabled={!value}>
          Clear
        </button>
      </div>
    </div>
  );
}
