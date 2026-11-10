import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import MockEndpointForm from './MockEndpointForm.jsx';
import MockScenarioEditor from './MockScenarioEditor.jsx';
import { useDialogs } from './Dialogs.jsx';
import { flattenWorkspaceRequests } from '../lib/monitorUi.js';
import {
  MOCK_LOG_LIMIT,
  canManageMocks,
  endpointScenarioCount,
  formatLatency,
  formatMockTime,
  headerRows,
  mockEndpointUrl,
  mockErrorText,
  normalizeMockEndpoints,
  normalizeMockLogs,
  requestOptionLabel,
} from '../lib/mockUi.js';

const hasBridge = typeof window !== 'undefined' && !!window.api;

function endpointLabel(endpoint) {
  return endpoint?.name || `${endpoint?.method || 'GET'} ${endpoint?.path || '/'}`;
}

export default function MockServerCloudTab({
  workspace,
  cloud,
  remoteWorkspaceId,
  onOpenCloud,
}) {
  const dialogs = useDialogs();
  const api = useMemo(
    () => (hasBridge ? window.api?.cloud : null),
    []
  );
  const collections = workspace?.collections || [];
  const requests = useMemo(() => flattenWorkspaceRequests(workspace), [workspace]);

  const [endpoints, setEndpoints] = useState([]);
  const [baseUrl, setBaseUrl] = useState('');
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [role, setRole] = useState(null);
  const [view, setView] = useState('endpoints');
  const [editing, setEditing] = useState(null);
  const [scenariosFor, setScenariosFor] = useState(null);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [generateMode, setGenerateMode] = useState('collection');
  const [generateCollection, setGenerateCollection] = useState('');
  const [generateRequest, setGenerateRequest] = useState('');
  const [generateResult, setGenerateResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [copied, setCopied] = useState('');
  const requestSeq = useRef(0);

  const signedIn = Boolean(cloud?.signedIn);
  const ready = signedIn && Boolean(remoteWorkspaceId);
  const canEdit = canManageMocks(role);

  const load = useCallback(
    async ({ quiet = false } = {}) => {
      if (!ready || !api || typeof api.mocks !== 'function') {
        setEndpoints([]);
        setBaseUrl('');
        setLogs([]);
        setLoading(false);
        return;
      }
      const seq = ++requestSeq.current;
      if (!quiet) setLoading(true);
      setError('');
      try {
        const mocksRes = await api.mocks(remoteWorkspaceId);
        if (seq !== requestSeq.current) return;
        if (!mocksRes?.ok) {
          setError(mockErrorText(mocksRes, 'Could not load server mocks.'));
          setEndpoints([]);
          setBaseUrl('');
        } else {
          const normalized = normalizeMockEndpoints(mocksRes.data);
          setEndpoints(normalized.endpoints);
          setBaseUrl(normalized.mockBaseUrl);
        }

        if (typeof api.mockLogs === 'function') {
          const logsRes = await api.mockLogs(remoteWorkspaceId, { limit: MOCK_LOG_LIMIT });
          if (seq !== requestSeq.current) return;
          if (logsRes?.ok) setLogs(normalizeMockLogs(logsRes.data));
          else if (!quiet) setLogs([]);
        }
      } catch (err) {
        if (seq === requestSeq.current) {
          setError(err?.message || 'Could not load server mocks.');
        }
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [api, ready, remoteWorkspaceId]
  );

  useEffect(() => {
    if (!ready) return undefined;
    load();
    return undefined;
  }, [load, ready]);

  // Resolve the caller's role so viewers do not see mutation controls. If it
  // cannot be resolved, the controls stay visible and the server enforces 403.
  useEffect(() => {
    setRole(null);
    if (!ready || !api || typeof api.members !== 'function') return undefined;
    let cancelled = false;
    (async () => {
      try {
        let userId = cloud?.user?.id || null;
        if (!userId && typeof api.me === 'function') {
          const me = await api.me();
          userId = me?.data?.user?.id || me?.data?.id || null;
        }
        if (!userId) return;
        const res = await api.members({ workspaceId: remoteWorkspaceId });
        if (!res?.ok || cancelled) return;
        const members = Array.isArray(res.data) ? res.data : [];
        const member = members.find((entry) => entry.userId === userId);
        if (member?.role) setRole(member.role);
      } catch {
        /* server remains the authority */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, cloud?.user?.id, ready, remoteWorkspaceId]);

  async function copyText(value, key) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied(''), 1500);
    } catch (err) {
      setError(err?.message || 'Could not copy.');
    }
  }

  async function saveEndpoint(payload) {
    setBusy(true);
    setError('');
    try {
      const res = editing?.id
        ? await api.updateMock(editing.id, payload)
        : await api.createMock(remoteWorkspaceId, payload);
      if (!res?.ok) {
        setError(mockErrorText(res, 'Could not save the mock.'));
        return;
      }
      setEditing(null);
      await load({ quiet: true });
    } catch (err) {
      setError(err?.message || 'Could not save the mock.');
    } finally {
      setBusy(false);
    }
  }

  async function removeEndpoint(endpoint) {
    const ok = await dialogs.confirm(`Delete mock "${endpointLabel(endpoint)}"?`, {
      title: 'Delete mock',
      okLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    setBusyId(endpoint.id);
    setError('');
    try {
      const res = await api.deleteMock(endpoint.id);
      if (!res?.ok) {
        setError(mockErrorText(res, 'Could not delete the mock.'));
        return;
      }
      await load({ quiet: true });
    } catch (err) {
      setError(err?.message || 'Could not delete the mock.');
    } finally {
      setBusyId(null);
    }
  }

  async function toggleEndpoint(endpoint) {
    setBusyId(endpoint.id);
    setError('');
    try {
      const res = await api.updateMock(endpoint.id, { enabled: !endpoint.enabled });
      if (!res?.ok) {
        setError(mockErrorText(res, 'Could not update the mock.'));
        return;
      }
      await load({ quiet: true });
    } catch (err) {
      setError(err?.message || 'Could not update the mock.');
    } finally {
      setBusyId(null);
    }
  }

  async function generate() {
    setBusy(true);
    setError('');
    setGenerateResult(null);
    try {
      const res =
        generateMode === 'collection'
          ? await api.mockFromCollection(remoteWorkspaceId, generateCollection, {})
          : await api.mockFromRequest(remoteWorkspaceId, generateRequest, {});
      if (!res?.ok) {
        setError(mockErrorText(res, 'Could not generate mocks.'));
        return;
      }
      if (generateMode === 'collection') {
        setGenerateResult({
          created: Array.isArray(res.data?.created) ? res.data.created : [],
          skipped: Array.isArray(res.data?.skipped) ? res.data.skipped : [],
        });
      } else {
        setGenerateResult({ created: res.data ? [res.data] : [], skipped: [] });
      }
      await load({ quiet: true });
    } catch (err) {
      setError(err?.message || 'Could not generate mocks.');
    } finally {
      setBusy(false);
    }
  }

  if (!signedIn) {
    return (
      <div className="mock-gate" data-testid="mock-cloud-gate">
        <div className="team-empty">Sign in to Relay Cloud to use server-side mocks.</div>
        <button type="button" className="send-btn" onClick={onOpenCloud}>
          <Icon name="cloud" size={12} /> Sign in
        </button>
        <p className="auth-hint">
          Local mocks keep working without an account; cloud mocks are also reachable from
          other machines.
        </p>
      </div>
    );
  }

  if (!remoteWorkspaceId) {
    return (
      <div className="mock-gate" data-testid="mock-cloud-gate">
        <div className="team-empty">This workspace is not linked to Relay Cloud.</div>
        <p className="auth-hint">
          Link it from the workspace switcher, then return here. Local mocks remain available.
        </p>
      </div>
    );
  }

  if (editing) {
    return (
      <MockEndpointForm
        endpoint={editing.id ? editing : null}
        busy={busy}
        onSubmit={saveEndpoint}
        onCancel={() => setEditing(null)}
      />
    );
  }

  if (scenariosFor) {
    return (
      <MockScenarioEditor
        endpoint={scenariosFor}
        api={api}
        canEdit={canEdit}
        onBack={() => setScenariosFor(null)}
        onChanged={() => load({ quiet: true })}
      />
    );
  }

  return (
    <div className="mock-cloud" data-testid="mock-cloud-tab">
      <div className="mock-url-row">
        <code className="mock-url" data-testid="mock-cloud-base-url">
          {baseUrl || 'Loading base URL…'}
        </code>
        <button
          type="button"
          className="mini-btn"
          disabled={!baseUrl}
          onClick={() => copyText(baseUrl, 'base')}
        >
          {copied === 'base' ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          className="mini-btn"
          onClick={() => load()}
          disabled={loading}
        >
          Refresh
        </button>
      </div>
      <p className="auth-hint mock-warning">
        Anyone with this URL can call the mock. Do not use it for sensitive data.
      </p>

      <div className="mock-cloud-actions">
        {canEdit && (
          <button
            type="button"
            className="send-btn"
            data-testid="mock-new"
            onClick={() => setEditing({})}
          >
            + New mock
          </button>
        )}
        {canEdit && (
          <button
            type="button"
            className="mini-btn"
            data-testid="mock-generate-open"
            onClick={() => {
              setGenerateOpen((open) => !open);
              setGenerateResult(null);
            }}
          >
            Generate from {generateMode === 'collection' ? 'collection' : 'request'}
          </button>
        )}
        <span className="mock-cloud-count">{endpoints.length} mock(s)</span>
      </div>

      {generateOpen && canEdit && (
        <div className="mock-generate" data-testid="mock-generate-panel">
          <div className="mock-mode-row">
            <label htmlFor="mock-generate-mode">Source</label>
            <select
              id="mock-generate-mode"
              value={generateMode}
              onChange={(e) => {
                setGenerateMode(e.target.value);
                setGenerateResult(null);
              }}
            >
              <option value="collection">Collection</option>
              <option value="request">Saved request</option>
            </select>
            {generateMode === 'collection' ? (
              <select
                value={generateCollection}
                onChange={(e) => setGenerateCollection(e.target.value)}
                aria-label="Collection"
              >
                <option value="">Pick a collection…</option>
                {collections.map((collection) => (
                  <option key={collection.id} value={collection.id}>
                    {collection.name}
                  </option>
                ))}
              </select>
            ) : (
              <select
                value={generateRequest}
                onChange={(e) => setGenerateRequest(e.target.value)}
                aria-label="Saved request"
              >
                <option value="">Pick a request…</option>
                {requests.map((request) => (
                  <option key={request.id} value={request.id}>
                    {requestOptionLabel(request)}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className="mini-btn"
              disabled={
                busy ||
                (generateMode === 'collection' ? !generateCollection : !generateRequest)
              }
              onClick={generate}
            >
              {busy ? 'Generating…' : 'Generate'}
            </button>
          </div>
          {generateResult && (
            <div className="mock-generate-result" data-testid="mock-generate-result">
              <strong>{generateResult.created.length} created</strong>
              {generateResult.skipped.length > 0 && (
                <span> · {generateResult.skipped.length} skipped</span>
              )}
              {generateResult.skipped.length > 0 && (
                <ul>
                  {generateResult.skipped.map((entry, index) => (
                    <li key={`${entry.requestId || 'skip'}-${index}`}>
                      {entry.requestId || 'request'}: {entry.reason || 'already exists'}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="mock-error" role="alert">
          {error}
          {error === 'Session expired — sign in again.' && onOpenCloud && (
            <button type="button" className="mini-btn" onClick={onOpenCloud}>
              Sign in
            </button>
          )}
        </div>
      )}

      <div className="mock-view-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'endpoints'}
          className={view === 'endpoints' ? 'active' : undefined}
          onClick={() => setView('endpoints')}
        >
          Endpoints <span className="badge">{endpoints.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'logs'}
          className={view === 'logs' ? 'active' : undefined}
          onClick={() => setView('logs')}
        >
          Logs <span className="badge">{logs.length}</span>
        </button>
      </div>

      {loading ? (
        <div className="team-empty">Loading server mocks…</div>
      ) : view === 'logs' ? (
        logs.length === 0 ? (
          <div className="team-empty">No requests recorded yet.</div>
        ) : (
          <div className="mock-log-wrap">
            <table className="mock-logs" data-testid="mock-cloud-logs">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Method</th>
                  <th>Path</th>
                  <th>Status</th>
                  <th>Latency</th>
                  <th>Remote IP</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((entry, index) => (
                  <tr
                    key={entry.id || `${entry.createdAt}-${index}`}
                    className={Number(entry.statusCode) >= 400 ? 'failed' : undefined}
                  >
                    <td>{formatMockTime(entry.createdAt)}</td>
                    <td>{entry.method}</td>
                    <td className="mock-log-path">{entry.path}</td>
                    <td>{entry.statusCode}</td>
                    <td>{formatLatency(entry.latencyMs)}</td>
                    <td>{entry.remoteIp || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : endpoints.length === 0 ? (
        <div className="team-empty">No server mocks yet.</div>
      ) : (
        <div className="mock-table-wrap">
          <table className="mock-table" data-testid="mock-cloud-endpoints">
            <thead>
              <tr>
                <th>Method</th>
                <th>Path</th>
                <th>Status</th>
                <th>Scenarios</th>
                <th>On</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {endpoints.map((endpoint) => (
                <tr key={endpoint.id}>
                  <td>
                    <span className={`mock-method ${String(endpoint.method || '').toLowerCase()}`}>
                      {endpoint.method}
                    </span>
                  </td>
                  <td className="mock-endpoint-path">
                    <span className="mock-endpoint-name">{endpoint.name}</span>
                    <code>{endpoint.path}</code>
                    <button
                      type="button"
                      className="mini-btn"
                      title="Copy mock URL"
                      onClick={() =>
                        copyText(mockEndpointUrl(baseUrl, endpoint.path), endpoint.id)
                      }
                    >
                      {copied === endpoint.id ? 'Copied' : 'Copy URL'}
                    </button>
                  </td>
                  <td>{endpoint.statusCode}</td>
                  <td>{endpointScenarioCount(endpoint)}</td>
                  <td>
                    <input
                      type="checkbox"
                      checked={endpoint.enabled !== false}
                      disabled={!canEdit || busyId === endpoint.id}
                      onChange={() => toggleEndpoint(endpoint)}
                      aria-label={`Enable ${endpointLabel(endpoint)}`}
                    />
                  </td>
                  <td className="mock-row-actions">
                    {canEdit && (
                      <button
                        type="button"
                        className="mini-btn"
                        onClick={() => setEditing(endpoint)}
                        disabled={busyId === endpoint.id}
                      >
                        Edit
                      </button>
                    )}
                    <button
                      type="button"
                      className="mini-btn"
                      onClick={() => setScenariosFor({ ...endpoint, responseHeaders: headerRows(endpoint.responseHeaders) })}
                      disabled={busyId === endpoint.id}
                    >
                      Scenarios
                    </button>
                    {canEdit && (
                      <button
                        type="button"
                        className="mini-btn danger"
                        onClick={() => removeEndpoint(endpoint)}
                        disabled={busyId === endpoint.id}
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
