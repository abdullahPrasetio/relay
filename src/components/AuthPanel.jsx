import React, { useState } from 'react';
import VarInput from './VarInput.jsx';

const BASE_TYPES = [
  { id: 'none', label: 'No Auth' },
  { id: 'bearer', label: 'Bearer Token' },
  { id: 'basic', label: 'Basic Auth' },
  { id: 'apikey', label: 'API Key' },
  { id: 'oauth2', label: 'OAuth 2.0' },
];

export default function AuthPanel({ auth, onChange, allowInherit = false }) {
  const TYPES = allowInherit
    ? [{ id: 'inherit', label: 'Inherit from parent' }, ...BASE_TYPES]
    : BASE_TYPES;
  const set = (patch) => onChange({ ...auth, ...patch });
  const setBearer = (patch) => onChange({ ...auth, bearer: { ...auth.bearer, ...patch } });
  const setBasic = (patch) => onChange({ ...auth, basic: { ...auth.basic, ...patch } });
  const setApiKey = (patch) => onChange({ ...auth, apikey: { ...auth.apikey, ...patch } });
  const setOAuth2 = (patch) => onChange({ ...auth, oauth2: { ...auth.oauth2, ...patch } });

  return (
    <div className="auth-panel">
      <div className="auth-row">
        <label>Type</label>
        <select value={auth.type} onChange={(e) => set({ type: e.target.value })}>
          {TYPES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      {auth.type === 'inherit' && (
        <p className="auth-hint">
          This request uses the authorization set on its parent collection.
        </p>
      )}

      {auth.type === 'none' && (
        <p className="auth-hint">This request does not use any authorization.</p>
      )}

      {auth.type === 'bearer' && (
        <div className="auth-row">
          <label>Token</label>
          <VarInput
            value={auth.bearer.token}
            placeholder="Token (supports {{var}})"
            onChange={(v) => setBearer({ token: v })}
          />
        </div>
      )}

      {auth.type === 'basic' && (
        <>
          <div className="auth-row">
            <label>Username</label>
            <VarInput
              value={auth.basic.username}
              onChange={(v) => setBasic({ username: v })}
            />
          </div>
          <div className="auth-row">
            <label>Password</label>
            <VarInput
              type="password"
              value={auth.basic.password}
              onChange={(v) => setBasic({ password: v })}
            />
          </div>
        </>
      )}

      {auth.type === 'apikey' && (
        <>
          <div className="auth-row">
            <label>Key</label>
            <VarInput
              value={auth.apikey.key}
              placeholder="e.g. X-API-Key"
              onChange={(v) => setApiKey({ key: v })}
            />
          </div>
          <div className="auth-row">
            <label>Value</label>
            <VarInput
              value={auth.apikey.value}
              onChange={(v) => setApiKey({ value: v })}
            />
          </div>
          <div className="auth-row">
            <label>Add to</label>
            <select
              value={auth.apikey.addTo}
              onChange={(e) => setApiKey({ addTo: e.target.value })}
            >
              <option value="header">Header</option>
              <option value="query">Query Params</option>
            </select>
          </div>
        </>
      )}

      {auth.type === 'oauth2' && <OAuth2Form oauth2={auth.oauth2} onChange={setOAuth2} />}
    </div>
  );
}

function OAuth2Form({ oauth2, onChange }) {
  const o = oauth2 || {};
  const [status, setStatus] = useState(null); // { type:'ok'|'err', msg }
  const [busy, setBusy] = useState(false);
  const hasBridge = typeof window !== 'undefined' && !!window.api?.getOAuth2Token;

  async function getToken() {
    if (!hasBridge) {
      setStatus({ type: 'err', msg: 'Token fetch only works in the desktop app.' });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const res = await window.api.getOAuth2Token(o);
      if (res.ok) {
        onChange({ accessToken: res.accessToken });
        setStatus({ type: 'ok', msg: 'Token fetched and applied.' });
      } else {
        setStatus({ type: 'err', msg: res.error || 'Failed to get token.' });
      }
    } catch (e) {
      setStatus({ type: 'err', msg: e.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="auth-row">
        <label>Grant Type</label>
        <select value={o.grantType} onChange={(e) => onChange({ grantType: e.target.value })}>
          <option value="client_credentials">Client Credentials</option>
          <option value="password">Password Credentials</option>
        </select>
      </div>
      <div className="auth-row">
        <label>Access Token URL</label>
        <VarInput
          value={o.accessTokenUrl}
          placeholder="https://auth.example.com/oauth/token"
          onChange={(v) => onChange({ accessTokenUrl: v })}
        />
      </div>
      <div className="auth-row">
        <label>Client ID</label>
        <VarInput value={o.clientId} onChange={(v) => onChange({ clientId: v })} />
      </div>
      <div className="auth-row">
        <label>Client Secret</label>
        <VarInput value={o.clientSecret} onChange={(v) => onChange({ clientSecret: v })} />
      </div>
      {o.grantType === 'password' && (
        <>
          <div className="auth-row">
            <label>Username</label>
            <VarInput value={o.username} onChange={(v) => onChange({ username: v })} />
          </div>
          <div className="auth-row">
            <label>Password</label>
            <VarInput value={o.password} onChange={(v) => onChange({ password: v })} />
          </div>
        </>
      )}
      <div className="auth-row">
        <label>Scope</label>
        <VarInput value={o.scope} placeholder="(optional)" onChange={(v) => onChange({ scope: v })} />
      </div>
      <div className="auth-row">
        <label>Client Auth</label>
        <select value={o.clientAuth} onChange={(e) => onChange({ clientAuth: e.target.value })}>
          <option value="body">Send in body</option>
          <option value="basic">Send as Basic Auth header</option>
        </select>
      </div>
      <div className="auth-row">
        <label>Access Token</label>
        <VarInput
          value={o.accessToken}
          placeholder="(fetched token appears here)"
          onChange={(v) => onChange({ accessToken: v })}
        />
      </div>
      <div className="auth-row">
        <label></label>
        <div>
          <button className="send-btn" onClick={getToken} disabled={busy}>
            {busy ? 'Requesting…' : 'Get New Access Token'}
          </button>
          {status && (
            <span
              className="meta"
              style={{ marginLeft: 10, color: status.type === 'ok' ? 'var(--green)' : 'var(--red)' }}
            >
              {status.msg}
            </span>
          )}
        </div>
      </div>
      <p className="auth-hint">
        The access token is sent as <code>Authorization: Bearer &lt;token&gt;</code>. Supports{' '}
        <code>{'{{var}}'}</code> in all fields.
      </p>
    </>
  );
}
