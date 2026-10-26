import React, { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import Icon from './Icon.jsx';

// Full CRUD for the persistent cookie jar (cookies auto-stored from responses
// and auto-sent on matching requests). Every mutation round-trips through the
// main process and reloads the list, so the table always reflects the jar.
const EMPTY_DRAFT = {
  name: '',
  value: '',
  domain: '',
  path: '/',
  expires: '',
  secure: false,
  httpOnly: false,
};

function errorMessage(err) {
  return err?.message || String(err);
}

// Show the stored epoch as an ISO string; users may type ISO or an epoch.
function draftFromCookie(c) {
  let expires = '';
  if (c.expires != null) {
    const d = new Date(c.expires);
    expires = Number.isNaN(d.getTime()) ? String(c.expires) : d.toISOString();
  }
  return {
    name: c.name || '',
    value: c.value || '',
    domain: c.domain || '',
    path: c.path || '/',
    expires,
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
  };
}

function payloadFromDraft(draft) {
  return {
    name: draft.name.trim(),
    value: draft.value,
    domain: draft.domain.trim(),
    path: draft.path.trim() || '/',
    expires: draft.expires.trim() || null,
    secure: !!draft.secure,
    httpOnly: !!draft.httpOnly,
  };
}

function CookieRow({ cookie, onSave, onDelete, disabled }) {
  const [draft, setDraft] = useState(() => draftFromCookie(cookie));
  const set = (field, value) => setDraft((d) => ({ ...d, [field]: value }));

  return (
    <tr>
      <td>
        <input
          aria-label="Cookie name"
          value={draft.name}
          onChange={(e) => set('name', e.target.value)}
        />
      </td>
      <td>
        <input
          aria-label="Cookie value"
          value={draft.value}
          onChange={(e) => set('value', e.target.value)}
        />
      </td>
      <td>
        <input
          aria-label="Cookie domain"
          value={draft.domain}
          onChange={(e) => set('domain', e.target.value)}
        />
      </td>
      <td>
        <input
          aria-label="Cookie path"
          value={draft.path}
          onChange={(e) => set('path', e.target.value)}
        />
      </td>
      <td>
        <input
          aria-label="Cookie expiry"
          placeholder="session"
          value={draft.expires}
          onChange={(e) => set('expires', e.target.value)}
        />
      </td>
      <td className="kv-check">
        <input
          type="checkbox"
          aria-label="Secure"
          checked={draft.secure}
          onChange={(e) => set('secure', e.target.checked)}
        />
      </td>
      <td className="kv-check">
        <input
          type="checkbox"
          aria-label="HttpOnly"
          checked={draft.httpOnly}
          onChange={(e) => set('httpOnly', e.target.checked)}
        />
      </td>
      <td className="kv-actions">
        <button
          className="icon-btn"
          title="Save cookie"
          disabled={disabled}
          onClick={() => onSave(payloadFromDraft(draft))}
        >
          <Icon name="save" size={14} />
        </button>
        <button
          className="icon-btn"
          title="Delete cookie"
          disabled={disabled}
          onClick={() => onDelete(cookie)}
        >
          <Icon name="trash" size={14} />
        </button>
      </td>
    </tr>
  );
}

export default function CookiesModal({ onClose }) {
  const [cookies, setCookies] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const hasBridge = typeof window !== 'undefined' && !!window.api?.getCookies;

  async function reload() {
    if (!hasBridge) return;
    const jar = await window.api.getCookies();
    setCookies(Array.isArray(jar) ? jar : []);
  }

  useEffect(() => {
    let mounted = true;
    if (hasBridge) {
      window.api
        .getCookies()
        .then((jar) => {
          if (!mounted) return;
          setCookies(Array.isArray(jar) ? jar : []);
          setLoaded(true);
        })
        .catch((err) => {
          if (!mounted) return;
          setError(errorMessage(err));
          setLoaded(true);
        });
    } else {
      setLoaded(true);
    }
    return () => {
      mounted = false;
    };
  }, [hasBridge]);

  // Run one mutation, then reload the jar. Errors stay inline; the modal stays
  // open so the user can fix the input.
  async function mutate(fn) {
    if (!hasBridge) {
      setError('Cookie editing requires the desktop app.');
      return false;
    }
    setSaving(true);
    try {
      await fn();
      await reload();
      setError('');
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveCookie(cookie) {
    if (!String(cookie.name || '').trim()) {
      setError('Cookie name is required.');
      return;
    }
    await mutate(() => window.api.setCookie(cookie));
  }

  async function addCookie() {
    const cookie = payloadFromDraft(draft);
    if (!cookie.name) {
      setError('Cookie name is required.');
      return;
    }
    const ok = await mutate(() => window.api.setCookie(cookie));
    if (ok) setDraft(EMPTY_DRAFT);
  }

  async function removeCookie(cookie) {
    await mutate(() =>
      window.api.deleteCookie({
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
      })
    );
  }

  async function clearAll() {
    await mutate(() => window.api.clearCookies());
  }

  const setDraftField = (field, value) => setDraft((d) => ({ ...d, [field]: value }));

  return (
    <Modal
      title="Cookies"
      onClose={onClose}
      width={980}
      footer={
        <>
          <button className="mini-btn" onClick={onClose}>
            Close
          </button>
          <button
            className="send-btn"
            style={{ background: 'var(--red)' }}
            onClick={clearAll}
            disabled={cookies.length === 0 || saving}
          >
            Clear All
          </button>
        </>
      }
    >
      {!loaded && <div className="response-empty">Loading…</div>}

      {loaded && error && (
        <div className="auth-hint" role="alert" style={{ color: 'var(--red)', marginBottom: 8 }}>
          {error}
        </div>
      )}

      {loaded && cookies.length === 0 && (
        <div className="response-empty">
          No cookies stored. Cookies set by responses are saved here and sent
          automatically on matching requests.
        </div>
      )}

      {loaded && cookies.length > 0 && (
        <table className="kv">
          <thead>
            <tr>
              <th>Name</th>
              <th>Value</th>
              <th>Domain</th>
              <th>Path</th>
              <th>Expires (ISO or epoch)</th>
              <th>Secure</th>
              <th>HttpOnly</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {cookies.map((c, i) => (
              <CookieRow
                key={`${c.domain}|${c.path}|${c.name}|${i}`}
                cookie={c}
                onSave={saveCookie}
                onDelete={removeCookie}
                disabled={saving}
              />
            ))}
          </tbody>
        </table>
      )}

      {loaded && (
        <div style={{ marginTop: 16 }}>
          <div className="auth-hint" style={{ marginBottom: 6 }}>
            Add a cookie
          </div>
          <table className="kv">
            <tbody>
              <tr>
                <td>
                  <input
                    aria-label="New cookie name"
                    placeholder="name"
                    value={draft.name}
                    onChange={(e) => setDraftField('name', e.target.value)}
                  />
                </td>
                <td>
                  <input
                    aria-label="New cookie value"
                    placeholder="value"
                    value={draft.value}
                    onChange={(e) => setDraftField('value', e.target.value)}
                  />
                </td>
                <td>
                  <input
                    aria-label="New cookie domain"
                    placeholder="example.com"
                    value={draft.domain}
                    onChange={(e) => setDraftField('domain', e.target.value)}
                  />
                </td>
                <td>
                  <input
                    aria-label="New cookie path"
                    placeholder="/"
                    value={draft.path}
                    onChange={(e) => setDraftField('path', e.target.value)}
                  />
                </td>
                <td>
                  <input
                    aria-label="New cookie expiry"
                    placeholder="session"
                    value={draft.expires}
                    onChange={(e) => setDraftField('expires', e.target.value)}
                  />
                </td>
                <td className="kv-check">
                  <input
                    type="checkbox"
                    aria-label="New cookie secure"
                    checked={draft.secure}
                    onChange={(e) => setDraftField('secure', e.target.checked)}
                  />
                </td>
                <td className="kv-check">
                  <input
                    type="checkbox"
                    aria-label="New cookie httpOnly"
                    checked={draft.httpOnly}
                    onChange={(e) => setDraftField('httpOnly', e.target.checked)}
                  />
                </td>
                <td className="kv-actions">
                  <button
                    className="icon-btn"
                    title="Add cookie"
                    disabled={saving}
                    onClick={addCookie}
                  >
                    <Icon name="plus" size={14} />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
