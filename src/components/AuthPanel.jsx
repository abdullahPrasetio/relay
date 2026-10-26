import React, { useEffect, useState } from 'react';
import VarInput from './VarInput.jsx';
import KeyValueEditor from './KeyValueEditor.jsx';

const BASE_TYPES = [
  { id: 'none', label: 'No Auth' },
  { id: 'bearer', label: 'Bearer Token' },
  { id: 'basic', label: 'Basic Auth' },
  { id: 'apikey', label: 'API Key' },
  { id: 'oauth1', label: 'OAuth 1.0' },
  { id: 'oauth2', label: 'OAuth 2.0' },
  { id: 'digest', label: 'Digest Auth' },
  { id: 'ntlm', label: 'NTLM' },
  { id: 'awsv4', label: 'AWS Signature' },
  { id: 'jwt', label: 'JWT Bearer' },
];

const textareaStyle = {
  flex: 1,
  minHeight: 90,
  background: 'var(--bg-3)',
  border: '1px solid var(--border)',
  color: 'var(--text)',
  padding: '7px 8px',
  borderRadius: 4,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  resize: 'vertical',
};

export default function AuthPanel({ auth, onChange, allowInherit = false }) {
  const TYPES = allowInherit
    ? [{ id: 'inherit', label: 'Inherit from parent' }, ...BASE_TYPES]
    : BASE_TYPES;
  const set = (patch) => onChange({ ...auth, ...patch });
  const setBearer = (patch) => onChange({ ...auth, bearer: { ...auth.bearer, ...patch } });
  const setBasic = (patch) => onChange({ ...auth, basic: { ...auth.basic, ...patch } });
  const setApiKey = (patch) => onChange({ ...auth, apikey: { ...auth.apikey, ...patch } });
  const setOAuth1 = (patch) => onChange({ ...auth, oauth1: { ...auth.oauth1, ...patch } });
  const setOAuth2 = (patch) => onChange({ ...auth, oauth2: { ...auth.oauth2, ...patch } });
  const setDigest = (patch) => onChange({ ...auth, digest: { ...auth.digest, ...patch } });
  const setNtlm = (patch) => onChange({ ...auth, ntlm: { ...auth.ntlm, ...patch } });
  const setAws = (patch) => onChange({ ...auth, awsv4: { ...auth.awsv4, ...patch } });
  const setJwt = (patch) => onChange({ ...auth, jwt: { ...auth.jwt, ...patch } });

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
            <VarInput value={auth.basic.username} onChange={(v) => setBasic({ username: v })} />
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
            <VarInput value={auth.apikey.value} onChange={(v) => setApiKey({ value: v })} />
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

      {auth.type === 'oauth1' && (
        <>
          <div className="auth-row">
            <label>Consumer Key</label>
            <VarInput
              value={auth.oauth1.consumerKey}
              onChange={(v) => setOAuth1({ consumerKey: v })}
            />
          </div>
          <div className="auth-row">
            <label>Consumer Secret</label>
            <VarInput
              type="password"
              value={auth.oauth1.consumerSecret}
              onChange={(v) => setOAuth1({ consumerSecret: v })}
            />
          </div>
          <div className="auth-row">
            <label>Token</label>
            <VarInput value={auth.oauth1.token} onChange={(v) => setOAuth1({ token: v })} />
          </div>
          <div className="auth-row">
            <label>Token Secret</label>
            <VarInput
              type="password"
              value={auth.oauth1.tokenSecret}
              onChange={(v) => setOAuth1({ tokenSecret: v })}
            />
          </div>
          <div className="auth-row">
            <label>Signature</label>
            <select
              value={auth.oauth1.signatureMethod}
              onChange={(e) => setOAuth1({ signatureMethod: e.target.value })}
            >
              <option value="HMAC-SHA1">HMAC-SHA1</option>
              <option value="HMAC-SHA256">HMAC-SHA256</option>
              <option value="PLAINTEXT">PLAINTEXT</option>
            </select>
          </div>
          <div className="auth-row">
            <label>Add to</label>
            <select
              value={auth.oauth1.addTo}
              onChange={(e) => setOAuth1({ addTo: e.target.value })}
            >
              <option value="header">Header</option>
              <option value="query">Query Params</option>
            </select>
          </div>
          <div className="auth-row">
            <label>Realm</label>
            <VarInput
              value={auth.oauth1.realm}
              placeholder="(optional)"
              onChange={(v) => setOAuth1({ realm: v })}
            />
          </div>
        </>
      )}

      {auth.type === 'oauth2' && <OAuth2Form oauth2={auth.oauth2} onChange={setOAuth2} />}

      {auth.type === 'digest' && (
        <>
          <div className="auth-row">
            <label>Username</label>
            <VarInput value={auth.digest.username} onChange={(v) => setDigest({ username: v })} />
          </div>
          <div className="auth-row">
            <label>Password</label>
            <VarInput
              type="password"
              value={auth.digest.password}
              onChange={(v) => setDigest({ password: v })}
            />
          </div>
          <div className="auth-row">
            <label>Algorithm</label>
            <select
              value={auth.digest.algorithm || 'MD5'}
              onChange={(e) => setDigest({ algorithm: e.target.value })}
            >
              <option value="MD5">MD5</option>
              <option value="SHA-256">SHA-256</option>
            </select>
          </div>
          <p className="auth-hint">
            The server challenge determines the algorithm; this is used when it is omitted.
          </p>
        </>
      )}

      {auth.type === 'ntlm' && (
        <>
          <div className="auth-row">
            <label>Username</label>
            <VarInput value={auth.ntlm.username} onChange={(v) => setNtlm({ username: v })} />
          </div>
          <div className="auth-row">
            <label>Password</label>
            <VarInput
              type="password"
              value={auth.ntlm.password}
              onChange={(v) => setNtlm({ password: v })}
            />
          </div>
          <div className="auth-row">
            <label>Domain</label>
            <VarInput
              value={auth.ntlm.domain}
              placeholder="(optional)"
              onChange={(v) => setNtlm({ domain: v })}
            />
          </div>
          <div className="auth-row">
            <label>Workstation</label>
            <VarInput
              value={auth.ntlm.workstation}
              placeholder="(optional)"
              onChange={(v) => setNtlm({ workstation: v })}
            />
          </div>
          <p className="auth-hint">
            NTLMv2 only. No channel binding, MIC or session signing; proxies that rewrite the
            connection may reject the Type 3 message.
          </p>
        </>
      )}

      {auth.type === 'awsv4' && (
        <>
          <div className="auth-row">
            <label>Access Key</label>
            <VarInput value={auth.awsv4.accessKey} onChange={(v) => setAws({ accessKey: v })} />
          </div>
          <div className="auth-row">
            <label>Secret Key</label>
            <VarInput
              type="password"
              value={auth.awsv4.secretKey}
              onChange={(v) => setAws({ secretKey: v })}
            />
          </div>
          <div className="auth-row">
            <label>Session Token</label>
            <VarInput
              value={auth.awsv4.sessionToken}
              placeholder="(optional, for temporary credentials)"
              onChange={(v) => setAws({ sessionToken: v })}
            />
          </div>
          <div className="auth-row">
            <label>Region</label>
            <VarInput
              value={auth.awsv4.region}
              placeholder="us-east-1"
              onChange={(v) => setAws({ region: v })}
            />
          </div>
          <div className="auth-row">
            <label>Service</label>
            <VarInput
              value={auth.awsv4.service}
              placeholder="execute-api"
              onChange={(v) => setAws({ service: v })}
            />
          </div>
          <div className="auth-row">
            <label>Add to</label>
            <select value={auth.awsv4.addTo} onChange={(e) => setAws({ addTo: e.target.value })}>
              <option value="header">Header</option>
              <option value="query">Query Params</option>
            </select>
          </div>
        </>
      )}

      {auth.type === 'jwt' && (
        <>
          <div className="auth-row">
            <label>Algorithm</label>
            <select
              value={auth.jwt.algorithm}
              onChange={(e) => setJwt({ algorithm: e.target.value })}
            >
              <option value="HS256">HS256</option>
              <option value="HS384">HS384</option>
              <option value="HS512">HS512</option>
              <option value="RS256">RS256</option>
              <option value="RS384">RS384</option>
              <option value="RS512">RS512</option>
            </select>
          </div>
          {String(auth.jwt.algorithm).startsWith('HS') ? (
            <div className="auth-row">
              <label>Secret</label>
              <VarInput
                type="password"
                value={auth.jwt.secret}
                onChange={(v) => setJwt({ secret: v })}
              />
            </div>
          ) : (
            <div className="auth-row">
              <label>Private Key</label>
              <textarea
                style={textareaStyle}
                value={auth.jwt.privateKey}
                placeholder="-----BEGIN PRIVATE KEY-----"
                onChange={(e) => setJwt({ privateKey: e.target.value })}
              />
            </div>
          )}
          <div className="auth-row">
            <label>Payload</label>
            <textarea
              style={textareaStyle}
              value={auth.jwt.payload}
              onChange={(e) => setJwt({ payload: e.target.value })}
            />
          </div>
          <div className="auth-row">
            <label>Key ID</label>
            <VarInput
              value={auth.jwt.kid}
              placeholder="(optional kid header)"
              onChange={(v) => setJwt({ kid: v })}
            />
          </div>
          <p className="auth-hint">
            The payload is signed as-is (no automatic iat/exp). Sent as{' '}
            <code>Authorization: Bearer &lt;token&gt;</code>.
          </p>
        </>
      )}
    </div>
  );
}

function OAuth2Form({ oauth2, onChange }) {
  const o = oauth2 || {};
  const [status, setStatus] = useState(null); // { type:'ok'|'err', msg }
  const [busy, setBusy] = useState(false);
  const [tokenStatus, setTokenStatus] = useState(null);
  const hasBridge = typeof window !== 'undefined' && !!window.api?.getOAuth2Token;
  const canAuthorize = typeof window !== 'undefined' && !!window.api?.authorizeOAuth2;
  const isCodeFlow = o.grantType === 'authorization_code';

  // Cached-token status lives in the main process; look it up only when the
  // config identity changes (never include the token itself in the deps).
  useEffect(() => {
    if (typeof window === 'undefined' || !window.api?.getOAuth2Status) return undefined;
    let cancelled = false;
    window.api
      .getOAuth2Status({
        accessTokenUrl: o.accessTokenUrl,
        clientId: o.clientId,
        scope: o.scope,
        audience: o.audience,
        grantType: o.grantType,
      })
      .then((result) => {
        if (!cancelled) setTokenStatus(result);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [o.accessTokenUrl, o.clientId, o.scope, o.audience, o.grantType]);

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
        onChange({
          accessToken: res.accessToken,
          refreshToken: res.refreshToken || o.refreshToken,
          tokenType: res.tokenType || 'Bearer',
          expiresAt: res.expiresIn ? Date.now() + res.expiresIn * 1000 : null,
        });
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

  async function authorize() {
    if (!canAuthorize) {
      setStatus({ type: 'err', msg: 'Authorization requires the desktop app.' });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const res = await window.api.authorizeOAuth2(o);
      if (res.ok) {
        onChange({
          accessToken: res.accessToken,
          refreshToken: res.refreshToken || o.refreshToken,
          tokenType: res.tokenType || 'Bearer',
          expiresAt: res.expiresAt ?? null,
        });
        setStatus({ type: 'ok', msg: 'Authorization complete.' });
      } else {
        setStatus({ type: 'err', msg: res.error || 'Authorization failed.' });
      }
    } catch (e) {
      setStatus({ type: 'err', msg: e.message });
    } finally {
      setBusy(false);
    }
  }

  const expiryValue = o.expiresAt || tokenStatus?.expiresAt || null;
  const expiry = expiryValue ? new Date(expiryValue).toLocaleString() : null;
  const hasToken = Boolean(o.accessToken || tokenStatus?.hasToken);

  return (
    <>
      <div className="auth-row">
        <label>Grant Type</label>
        <select value={o.grantType} onChange={(e) => onChange({ grantType: e.target.value })}>
          <option value="authorization_code">Authorization Code</option>
          <option value="client_credentials">Client Credentials</option>
          <option value="password">Password Credentials</option>
          <option value="refresh_token">Refresh Token</option>
        </select>
      </div>
      {isCodeFlow && (
        <div className="auth-row">
          <label>Auth URL</label>
          <VarInput
            value={o.authUrl}
            placeholder="https://auth.example.com/oauth/authorize"
            onChange={(v) => onChange({ authUrl: v })}
          />
        </div>
      )}
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
        <VarInput
          type="password"
          value={o.clientSecret}
          onChange={(v) => onChange({ clientSecret: v })}
        />
      </div>
      {o.grantType === 'password' && (
        <>
          <div className="auth-row">
            <label>Username</label>
            <VarInput value={o.username} onChange={(v) => onChange({ username: v })} />
          </div>
          <div className="auth-row">
            <label>Password</label>
            <VarInput
              type="password"
              value={o.password}
              onChange={(v) => onChange({ password: v })}
            />
          </div>
        </>
      )}
      <div className="auth-row">
        <label>Scope</label>
        <VarInput
          value={o.scope}
          placeholder="(optional)"
          onChange={(v) => onChange({ scope: v })}
        />
      </div>
      <div className="auth-row">
        <label>Audience</label>
        <VarInput
          value={o.audience}
          placeholder="(optional)"
          onChange={(v) => onChange({ audience: v })}
        />
      </div>
      <div className="auth-row">
        <label>Client Auth</label>
        <select value={o.clientAuth} onChange={(e) => onChange({ clientAuth: e.target.value })}>
          <option value="body">Send in body</option>
          <option value="basic">Send as Basic Auth header</option>
        </select>
      </div>
      <div className="auth-row">
        <label>Extra Params</label>
        <div style={{ flex: 1 }}>
          <KeyValueEditor
            rows={Array.isArray(o.extraParams) ? o.extraParams : []}
            onChange={(rows) => onChange({ extraParams: rows })}
            keyPlaceholder="Parameter"
            valuePlaceholder="Value"
          />
        </div>
      </div>
      <div className="auth-row">
        <label>Refresh Token</label>
        <VarInput
          type="password"
          value={o.refreshToken}
          placeholder="(stored automatically after authorize)"
          onChange={(v) => onChange({ refreshToken: v })}
        />
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
          {isCodeFlow ? (
            <button className="send-btn" onClick={authorize} disabled={busy || !canAuthorize}>
              {busy ? 'Waiting…' : 'Authorize'}
            </button>
          ) : (
            <button className="send-btn" onClick={getToken} disabled={busy || !hasBridge}>
              {busy ? 'Requesting…' : 'Get New Access Token'}
            </button>
          )}
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
        {hasToken
          ? `Access token present${expiry ? `, expires ${expiry}` : ''}.`
          : 'No access token yet.'}
        {tokenStatus?.expired ? ' (expired — will refresh on send)' : ''}
      </p>
      <p className="auth-hint">
        The access token is sent as <code>Authorization: Bearer &lt;token&gt;</code>. Expired tokens
        with a refresh token are refreshed automatically in the desktop app.
      </p>
    </>
  );
}
