import React, { useEffect, useState } from 'react';
import Modal from './Modal.jsx';

// Relay API server selection. The URL is persisted in the main process and
// applied to the cloud client + change stream immediately. Tokens are
// server-scoped, so changing the URL signs the user out first.
export default function CloudServerModal({ cloud, onClose }) {
  const [baseUrl, setBaseUrl] = useState('');
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const bridge = typeof window !== 'undefined' ? window.api?.cloud : null;

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!bridge?.getConfig) {
        setError('Cloud server settings are only available in the desktop app.');
        setLoading(false);
        return;
      }
      try {
        const res = await bridge.getConfig();
        if (!alive) return;
        if (!res?.ok) setError(res?.error?.message || 'Could not load the server URL.');
        else {
          setBaseUrl(res.data?.baseUrl || '');
          setLocked(Boolean(res.data?.locked));
        }
      } catch (err) {
        if (alive) setError(err?.message || String(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [bridge]);

  async function save() {
    if (locked) return;
    const value = baseUrl.trim();
    if (!value) {
      setError('Relay API URL is required.');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      if (cloud?.signedIn) {
        await cloud.signOut?.();
      }
      const res = await bridge.setBaseUrl({ baseUrl: value });
      if (!res?.ok) {
        setError(res?.error?.message || 'Could not change the server URL.');
        return;
      }
      setBaseUrl(res.data?.baseUrl || value);
      setNotice('Server URL saved. Sign in against the new server to sync.');
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title="Relay Cloud server"
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="mini-btn" onClick={onClose}>
            Close
          </button>
          <button
            className="send-btn"
            data-testid="cloud-server-save"
            onClick={save}
            disabled={loading || saving || locked}
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
            <p className="auth-hint settings-error" data-testid="cloud-server-error">
              {error}
            </p>
          )}
          {notice && (
            <p className="auth-hint" data-testid="cloud-server-notice">
              {notice}
            </p>
          )}

          <div className="form-row">
            <label htmlFor="cloud-server-url">Relay API URL</label>
            <input
              id="cloud-server-url"
              data-testid="cloud-server-url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://127.0.0.1:8080"
              readOnly={locked}
            />
            <p className="auth-hint">
              Bare origin or a URL ending in <code>/api/v1</code>. Requests go directly
              from this desktop app to that server.
            </p>
          </div>

          {locked && (
            <p className="auth-hint" data-testid="cloud-server-locked">
              This URL is fixed by the <code>RELAY_API_URL</code> environment variable.
            </p>
          )}
          {!locked && cloud?.signedIn && (
            <p className="auth-hint" data-testid="cloud-server-signout-warning">
              Changing the server signs you out. Workspaces linked to the previous server
              keep their local link until you detach them.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}
