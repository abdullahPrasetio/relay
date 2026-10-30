import React, { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import { validateSettingsDraft } from '../lib/confluenceUi.js';

function toDraft(config) {
  return {
    baseUrl: config?.baseUrl || '',
    authMethod: config?.authMethod || 'cloud',
    email: config?.email || '',
    token: '',
    clearToken: false,
    hasToken: !!config?.hasToken,
    allowInsecureTls: config?.allowInsecureTls === true,
  };
}

// Workspace-scoped Confluence connection. The token is write-only: the main
// process encrypts it and only returns `hasToken`.
export default function ConfluenceSettingsModal({ workspace, onClose }) {
  const [draft, setDraft] = useState(() => toDraft(null));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const bridge = typeof window !== 'undefined' ? window.api : null;

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!bridge?.confluenceGetConfig) {
        setLoading(false);
        setError('Confluence is only available in the desktop app.');
        return;
      }
      try {
        const res = await bridge.confluenceGetConfig(workspace.id);
        if (!alive) return;
        if (!res?.ok) setError(res?.error || 'Could not load Confluence settings.');
        else setDraft(toDraft(res.config));
      } catch (err) {
        if (alive) setError(err?.message || String(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [bridge, workspace.id]);

  const set = (patch) => setDraft((prev) => ({ ...prev, ...patch }));

  function payload() {
    const out = {
      workspaceId: workspace.id,
      baseUrl: draft.baseUrl,
      authMethod: draft.authMethod,
      email: draft.email,
      allowInsecureTls: draft.allowInsecureTls,
    };
    if (draft.clearToken) out.clearToken = true;
    else if (draft.token.trim()) out.token = draft.token;
    return out;
  }

  async function save({ close = false } = {}) {
    const problem = validateSettingsDraft(draft);
    if (problem) {
      setError(problem);
      return false;
    }
    setError('');
    setNotice('');
    setSaving(true);
    try {
      const res = await bridge.confluenceSetConfig(payload());
      if (!res?.ok) {
        setError(res?.error || 'Could not save Confluence settings.');
        return false;
      }
      setDraft(toDraft(res.config));
      setNotice('Saved.');
      if (close) onClose();
      return true;
    } catch (err) {
      setError(err?.message || 'Could not save Confluence settings.');
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    const saved = await save();
    if (!saved) return;
    setTesting(true);
    setError('');
    setNotice('');
    try {
      const res = await bridge.confluenceTest(workspace.id);
      if (!res?.ok) setError(res?.error || 'Connection failed.');
      else {
        setNotice(
          `Connected${res.displayName ? ` as ${res.displayName}` : ''}${
            res.email ? ` (${res.email})` : ''
          }.`
        );
      }
    } catch (err) {
      setError(err?.message || 'Connection failed.');
    } finally {
      setTesting(false);
    }
  }

  return (
    <Modal
      title={`Confluence · ${workspace.name}`}
      onClose={onClose}
      width={620}
      footer={
        <>
          <button className="mini-btn" onClick={onClose}>
            Close
          </button>
          <button
            className="mini-btn"
            data-testid="confluence-test"
            onClick={test}
            disabled={loading || saving || testing}
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <button
            className="send-btn"
            data-testid="confluence-save"
            onClick={() => save({ close: true })}
            disabled={loading || saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      {loading ? (
        <p className="auth-hint">Loading…</p>
      ) : (
        <>
          {error && (
            <p className="auth-hint settings-error" data-testid="confluence-error">
              {error}
            </p>
          )}
          {notice && (
            <p className="auth-hint" data-testid="confluence-notice">
              {notice}
            </p>
          )}

          <div className="form-row">
            <label htmlFor="confluence-base">Base URL</label>
            <input
              id="confluence-base"
              data-testid="confluence-base-url"
              value={draft.baseUrl}
              onChange={(e) => set({ baseUrl: e.target.value })}
              placeholder="https://org.atlassian.net/wiki"
            />
            <p className="auth-hint">
              Cloud: <code>https://org.atlassian.net/wiki</code>. Data Center:
              <code> https://confluence.example.com</code>.
            </p>
          </div>

          <div className="form-row">
            <label htmlFor="confluence-auth">Authentication</label>
            <select
              id="confluence-auth"
              data-testid="confluence-auth-method"
              value={draft.authMethod}
              onChange={(e) => set({ authMethod: e.target.value })}
            >
              <option value="cloud">Cloud (email + API token)</option>
              <option value="pat">Data Center / Server (PAT)</option>
            </select>
          </div>

          {draft.authMethod === 'cloud' && (
            <div className="form-row">
              <label htmlFor="confluence-email">Email</label>
              <input
                id="confluence-email"
                data-testid="confluence-email"
                value={draft.email}
                onChange={(e) => set({ email: e.target.value })}
                placeholder="you@example.com"
              />
            </div>
          )}

          <div className="form-row">
            <label htmlFor="confluence-token">
              {draft.authMethod === 'pat' ? 'Personal access token' : 'API token'}
            </label>
            <input
              id="confluence-token"
              data-testid="confluence-token"
              type="password"
              value={draft.token}
              onChange={(e) => set({ token: e.target.value, clearToken: false })}
              placeholder={draft.hasToken ? '•••• saved — leave blank to keep' : 'Paste token'}
              autoComplete="off"
            />
            {draft.hasToken && (
              <button
                type="button"
                className="mini-btn"
                data-testid="confluence-clear-token"
                onClick={() => set({ token: '', clearToken: true, hasToken: false })}
              >
                Clear stored token
              </button>
            )}
            <p className="auth-hint">
              Stored encrypted on this machine only. It is never sent to Relay Cloud or
              included in workspace exports.
            </p>
          </div>

          <label className="settings-check">
            <input
              type="checkbox"
              data-testid="confluence-insecure"
              checked={draft.allowInsecureTls}
              onChange={(e) => set({ allowInsecureTls: e.target.checked })}
            />
            Allow self-signed TLS certificates
          </label>
          <p className="auth-hint">
            Only enable this for an on-premise Confluence instance you trust.
          </p>
        </>
      )}
    </Modal>
  );
}
