import React, { useState } from 'react';
import Modal from './Modal.jsx';

// Per-request overrides of the app network settings. Blank / "Use default"
// fields inherit from the app settings, so changing the app default later
// still affects this request.
const TRI_STATE = [
  { value: 'default', label: 'Use default' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

function triToBool(value) {
  if (value === 'on') return true;
  if (value === 'off') return false;
  return null;
}

function boolToTri(value) {
  if (value === true) return 'on';
  if (value === false) return 'off';
  return 'default';
}

function toDraft(settings) {
  const s = settings || {};
  return {
    timeoutMs: s.timeoutMs == null ? '' : String(s.timeoutMs),
    followRedirects: boolToTri(s.followRedirects),
    maxRedirects: s.maxRedirects == null ? '' : String(s.maxRedirects),
    verifyTls: boolToTri(s.verifyTls),
    proxyId: s.proxyId == null ? 'default' : s.proxyId,
  };
}

function validate(draft) {
  if (String(draft.timeoutMs).trim() !== '') {
    const n = Number(draft.timeoutMs);
    if (!Number.isInteger(n) || n < 1 || n > 3600000) {
      return 'Timeout must be a whole number between 1 and 3600000 ms, or blank to inherit.';
    }
  }
  if (String(draft.maxRedirects).trim() !== '') {
    const n = Number(draft.maxRedirects);
    if (!Number.isInteger(n) || n < 0 || n > 50) {
      return 'Max redirects must be a whole number between 0 and 50, or blank to inherit.';
    }
  }
  return '';
}

function buildSettings(draft) {
  const timeout = String(draft.timeoutMs).trim();
  const maxRedirects = String(draft.maxRedirects).trim();
  return {
    timeoutMs: timeout === '' ? null : Number(timeout),
    followRedirects: triToBool(draft.followRedirects),
    maxRedirects: maxRedirects === '' ? null : Number(maxRedirects),
    verifyTls: triToBool(draft.verifyTls),
    proxyId: draft.proxyId === 'default' ? null : draft.proxyId,
  };
}

export default function RequestSettingsModal({ request, networkSettings, onChange, onClose }) {
  const [draft, setDraft] = useState(() => toDraft(request?.settings));
  const [error, setError] = useState('');

  const set = (patch) => setDraft((prev) => ({ ...prev, ...patch }));
  const proxies = networkSettings?.proxies || [];

  function submit() {
    const problem = validate(draft);
    if (problem) {
      setError(problem);
      return;
    }
    onChange(buildSettings(draft));
    onClose();
  }

  return (
    <Modal
      title="Request settings"
      onClose={onClose}
      width={560}
      footer={
        <>
          <button className="mini-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="send-btn"
            data-testid="request-settings-save"
            onClick={submit}
          >
            Save
          </button>
        </>
      }
    >
      {error && (
        <p className="auth-hint settings-error" data-testid="request-settings-error">
          {error}
        </p>
      )}
      <p className="auth-hint">
        These settings apply to this request only. Blank fields use the app-wide
        network settings.
      </p>

      <div className="form-row">
        <label htmlFor="request-timeout">Timeout (ms)</label>
        <input
          id="request-timeout"
          data-testid="request-timeout"
          type="number"
          min="1"
          max="3600000"
          placeholder="Inherit"
          value={draft.timeoutMs}
          onChange={(e) => set({ timeoutMs: e.target.value })}
        />
      </div>

      <div className="form-row">
        <label htmlFor="request-follow-redirects">Follow redirects</label>
        <select
          id="request-follow-redirects"
          data-testid="request-follow-redirects"
          value={draft.followRedirects}
          onChange={(e) => set({ followRedirects: e.target.value })}
        >
          {TRI_STATE.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="form-row">
        <label htmlFor="request-max-redirects">Max redirects</label>
        <input
          id="request-max-redirects"
          data-testid="request-max-redirects"
          type="number"
          min="0"
          max="50"
          placeholder="Inherit"
          value={draft.maxRedirects}
          onChange={(e) => set({ maxRedirects: e.target.value })}
        />
      </div>

      <div className="form-row">
        <label htmlFor="request-verify-tls">Verify TLS certificates</label>
        <select
          id="request-verify-tls"
          data-testid="request-verify-tls"
          value={draft.verifyTls}
          onChange={(e) => set({ verifyTls: e.target.value })}
        >
          {TRI_STATE.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="form-row">
        <label htmlFor="request-proxy">Proxy</label>
        <select
          id="request-proxy"
          data-testid="request-proxy"
          value={draft.proxyId}
          onChange={(e) => set({ proxyId: e.target.value })}
        >
          <option value="default">Use default</option>
          <option value="none">No proxy</option>
          {proxies.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name || 'Proxy'}
            </option>
          ))}
        </select>
      </div>
    </Modal>
  );
}
