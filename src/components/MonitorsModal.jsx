import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Modal from './Modal.jsx';
import Icon from './Icon.jsx';
import { useDialogs } from './Dialogs.jsx';
import { formatDateTime, shortId } from '../lib/deviceUi.js';
import {
  CRON_PRESETS,
  canManageMonitors,
  cronLabel,
  flattenWorkspaceRequests,
  formatLastRun,
  formatNextRun,
  normalizeRuns,
  requestOptionLabel,
  summarizeRun,
} from '../lib/monitorUi.js';

const RUN_LIMIT = 20;
const CUSTOM_CRON = '__custom__';

function errorMessage(res, fallback) {
  return res?.error?.message || fallback;
}

function byId(list) {
  const map = Object.create(null);
  for (const entry of list || []) {
    if (entry?.id !== undefined && entry?.id !== null) map[String(entry.id)] = entry;
  }
  return map;
}

function RunHistory({ state }) {
  const runs = state?.runs || [];
  if (state?.loading && runs.length === 0) {
    return (
      <div className="monitor-runs">
        <div className="team-empty">Loading runs…</div>
      </div>
    );
  }
  if (state?.error && runs.length === 0) {
    return (
      <div className="monitor-runs">
        <div className="cloud-error team-error" role="alert">
          {state.error}
        </div>
      </div>
    );
  }
  if (runs.length === 0) {
    return (
      <div className="monitor-runs">
        <div className="team-empty">No runs recorded yet.</div>
      </div>
    );
  }

  return (
    <div className="monitor-runs">
      {state?.error && (
        <div className="cloud-error team-error" role="alert">
          {state.error}
        </div>
      )}
      <ol className="monitor-run-list">
        {runs.map((entry, index) => {
          const run = summarizeRun(entry);
          return (
            <li
              key={entry.id || `${entry.startedAt || 'run'}-${index}`}
              className="monitor-run"
            >
              <span className={`monitor-run-badge ${run.ok ? 'ok' : 'fail'}`}>
                {run.status}
              </span>
              <span className="monitor-run-code">{run.statusCode ?? '—'}</span>
              <span className="monitor-run-duration">{run.duration}</span>
              <span className="monitor-run-assertions">
                {run.assertions > 0 ? run.assertionsLabel : 'No assertion failures'}
              </span>
              <span
                className="monitor-run-time"
                title={formatDateTime(entry.startedAt) || ''}
              >
                {formatDateTime(entry.startedAt) || formatLastRun(entry.startedAt)}
              </span>
              {run.error && (
                <span className="monitor-run-error" title={run.error}>
                  {run.error}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// Scheduled monitors for one linked workspace. The modal reuses the same
// main-process bridge as the team/audit modals and never talks to the
// backend directly. Viewers get a read-only list and history.
export default function MonitorsModal({
  workspace,
  role = null,
  currentUserId = null,
  cloud: cloudBridge = null,
  onClose,
}) {
  const dialogs = useDialogs();
  const api = useMemo(
    () => cloudBridge || (typeof window !== 'undefined' ? window.api?.cloud : null),
    [cloudBridge]
  );
  const remoteId = workspace?.cloud?.remoteId || null;
  const requestOptions = useMemo(() => flattenWorkspaceRequests(workspace), [workspace]);
  const optionsById = useMemo(() => byId(requestOptions), [requestOptions]);

  const [monitors, setMonitors] = useState([]);
  const [latestRuns, setLatestRuns] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [callerRole, setCallerRole] = useState(role || null);
  const [expandedId, setExpandedId] = useState(null);
  const [histories, setHistories] = useState({});
  const [runningId, setRunningId] = useState(null);
  const [togglingId, setTogglingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    name: '',
    requestId: '',
    cronPreset: CRON_PRESETS[0].value,
    customCron: '',
    enabled: true,
    alertWebhook: '',
  });
  const requestSeq = useRef(0);

  const canMutate = canManageMonitors(role || callerRole);

  useEffect(() => {
    setCallerRole(role || null);
  }, [role]);

  // Resolve the caller's workspace role so viewer controls stay hidden. When
  // the role cannot be resolved the modal keeps the controls and lets the
  // server reject unauthorized mutations.
  useEffect(() => {
    if (role) return undefined;
    if (!remoteId || !api) return undefined;
    let cancelled = false;
    (async () => {
      try {
        let selfId = currentUserId;
        if (!selfId && typeof api.me === 'function') {
          const me = await api.me();
          const identity = me?.data?.user || me?.data;
          selfId = identity?.id || identity?.userId || null;
        }
        if (!selfId || typeof api.members !== 'function') return;
        const res = await api.members({ workspaceId: remoteId });
        if (cancelled || !res?.ok) return;
        const members = Array.isArray(res.data) ? res.data : [];
        const member = members.find((entry) => entry.userId === selfId);
        if (member?.role) setCallerRole(member.role);
      } catch {
        /* controls stay visible; server enforces permissions */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, currentUserId, remoteId, role]);

  const load = useCallback(
    async ({ quiet = false } = {}) => {
      const seq = ++requestSeq.current;
      if (!remoteId) {
        setMonitors([]);
        setLatestRuns({});
        setLoading(false);
        setError('This workspace is not attached to Relay Cloud.');
        return;
      }
      if (!api || typeof api.monitors !== 'function') {
        setMonitors([]);
        setLatestRuns({});
        setLoading(false);
        setError('Monitor management requires the desktop app.');
        return;
      }
      if (!quiet) setLoading(true);
      setError('');
      try {
        const res = await api.monitors(remoteId);
        if (seq !== requestSeq.current) return;
        if (!res?.ok) {
          setMonitors([]);
          setLatestRuns({});
          setError(errorMessage(res, 'Could not load monitors.'));
          return;
        }
        const list = Array.isArray(res.data) ? res.data : [];
        setMonitors(list);

        // The list endpoint carries nextRunAt/lastRunAt but not the outcome
        // of the last run, so one extra request per monitor fills that in.
        const latest = {};
        await Promise.all(
          list.map(async (monitor) => {
            if (!monitor?.id) return;
            try {
              const runsRes = await api.monitorRuns(monitor.id, { limit: 1 });
              if (!runsRes?.ok) return;
              const runs = normalizeRuns(runsRes.data);
              if (runs.length) latest[monitor.id] = runs[0];
            } catch {
              /* a missing history must not hide the monitor list */
            }
          })
        );
        if (seq === requestSeq.current) setLatestRuns(latest);
      } catch (err) {
        if (seq !== requestSeq.current) return;
        setMonitors([]);
        setLatestRuns({});
        setError(err?.message || 'Could not load monitors.');
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [api, remoteId]
  );

  useEffect(() => {
    load();
  }, [load]);

  const loadHistory = useCallback(
    async (id, { quiet = false } = {}) => {
      if (!api || typeof api.monitorRuns !== 'function') {
        setHistories((prev) => ({
          ...prev,
          [id]: { loading: false, error: 'Run history requires the desktop app.', runs: [] },
        }));
        return;
      }
      setHistories((prev) => ({
        ...prev,
        [id]: { loading: !quiet, error: '', runs: prev[id]?.runs || [] },
      }));
      try {
        const res = await api.monitorRuns(id, { limit: RUN_LIMIT });
        if (!res?.ok) {
          setHistories((prev) => ({
            ...prev,
            [id]: {
              loading: false,
              error: errorMessage(res, 'Could not load run history.'),
              runs: prev[id]?.runs || [],
            },
          }));
          return;
        }
        const runs = normalizeRuns(res.data);
        setHistories((prev) => ({ ...prev, [id]: { loading: false, error: '', runs } }));
        if (runs.length) setLatestRuns((prev) => ({ ...prev, [id]: runs[0] }));
      } catch (err) {
        setHistories((prev) => ({
          ...prev,
          [id]: {
            loading: false,
            error: err?.message || 'Could not load run history.',
            runs: prev[id]?.runs || [],
          },
        }));
      }
    },
    [api]
  );

  function toggleHistory(monitor) {
    if (expandedId === monitor.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(monitor.id);
    if (!histories[monitor.id] || histories[monitor.id].error) loadHistory(monitor.id);
  }

  async function toggleEnabled(monitor) {
    if (!api || togglingId || !canMutate) return;
    const enabled = !monitor.enabled;
    setTogglingId(monitor.id);
    setError('');
    try {
      const res = await api.updateMonitor(monitor.id, { enabled });
      if (!res?.ok) {
        setError(errorMessage(res, 'Could not update this monitor.'));
        return;
      }
      const updated = res.data && typeof res.data === 'object' ? res.data : {};
      setMonitors((prev) =>
        prev.map((entry) =>
          entry.id === monitor.id
            ? {
                ...entry,
                ...updated,
                enabled: typeof updated.enabled === 'boolean' ? updated.enabled : enabled,
              }
            : entry
        )
      );
    } catch (err) {
      setError(err?.message || 'Could not update this monitor.');
    } finally {
      setTogglingId(null);
    }
  }

  async function runNow(monitor) {
    if (!api || runningId || !canMutate) return;
    setRunningId(monitor.id);
    setError('');
    try {
      const res = await api.runMonitor(monitor.id);
      if (!res?.ok) {
        setError(errorMessage(res, 'Could not run this monitor.'));
        return;
      }
      if (res.data && typeof res.data === 'object') {
        setLatestRuns((prev) => ({ ...prev, [monitor.id]: res.data }));
      }
      await load({ quiet: true });
      if (expandedId === monitor.id || histories[monitor.id]) {
        await loadHistory(monitor.id, { quiet: true });
      }
    } catch (err) {
      setError(err?.message || 'Could not run this monitor.');
    } finally {
      setRunningId(null);
    }
  }

  async function removeMonitor(monitor) {
    if (!api || deletingId || !canMutate) return;
    const ok = await dialogs.confirm(
      `Delete monitor "${monitor.name || 'Untitled monitor'}"? Its run history will be removed too.`,
      { title: 'Delete monitor', okLabel: 'Delete', danger: true }
    );
    if (!ok) return;
    setDeletingId(monitor.id);
    setError('');
    try {
      const res = await api.deleteMonitor(monitor.id);
      if (!res?.ok) {
        setError(errorMessage(res, 'Could not delete this monitor.'));
        return;
      }
      setMonitors((prev) => prev.filter((entry) => entry.id !== monitor.id));
      setLatestRuns((prev) => {
        const next = { ...prev };
        delete next[monitor.id];
        return next;
      });
      setHistories((prev) => {
        const next = { ...prev };
        delete next[monitor.id];
        return next;
      });
      if (expandedId === monitor.id) setExpandedId(null);
    } catch (err) {
      setError(err?.message || 'Could not delete this monitor.');
    } finally {
      setDeletingId(null);
    }
  }

  function chooseRequest(requestId) {
    const option = optionsById[requestId];
    setForm((prev) => ({
      ...prev,
      requestId,
      name: prev.name.trim() ? prev.name : option?.name || '',
    }));
  }

  async function createMonitor(event) {
    event.preventDefault();
    if (!api || creating || !canMutate || !remoteId) return;
    const name = form.name.trim();
    const cron =
      form.cronPreset === CUSTOM_CRON ? form.customCron.trim() : form.cronPreset.trim();
    if (!name) {
      setError('Give the monitor a name.');
      return;
    }
    if (!form.requestId) {
      setError('Choose a request to monitor.');
      return;
    }
    if (!cron) {
      setError('Enter a cron expression.');
      return;
    }

    setCreating(true);
    setError('');
    try {
      const payload = {
        name,
        requestId: form.requestId,
        cron,
        enabled: form.enabled,
      };
      const webhook = form.alertWebhook.trim();
      if (webhook) payload.alertWebhook = webhook;
      const res = await api.createMonitor(remoteId, payload);
      if (!res?.ok) {
        setError(errorMessage(res, 'Could not create the monitor.'));
        return;
      }
      setForm((prev) => ({ ...prev, name: '', requestId: '', alertWebhook: '' }));
      await load({ quiet: true });
    } catch (err) {
      setError(err?.message || 'Could not create the monitor.');
    } finally {
      setCreating(false);
    }
  }

  const hasRequests = requestOptions.length > 0;

  return (
    <Modal
      title={`Monitors · ${workspace?.name || 'Workspace'}`}
      onClose={onClose}
      width={720}
      footer={
        <button type="button" className="mini-btn" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="monitors-modal" data-testid="workspace-monitors-modal">
        {error && (
          <div className="cloud-error team-error" role="alert">
            {error}
          </div>
        )}

        {!remoteId ? (
          <div className="team-empty">
            This workspace is not attached to Relay Cloud. Link it first to schedule monitors.
          </div>
        ) : !api || typeof api.monitors !== 'function' ? (
          <div className="team-empty">Monitor management requires the desktop app.</div>
        ) : (
          <>
            <section className="team-section">
              <div className="team-section-head">
                <span className="team-section-title">Scheduled monitors</span>
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() => load()}
                  disabled={loading}
                >
                  {loading ? 'Loading…' : 'Refresh'}
                </button>
              </div>

              {!canMutate && (
                <p className="team-hint">
                  Your role in this workspace is {callerRole || 'viewer'}; monitors are read-only.
                </p>
              )}

              {loading ? (
                <div className="team-empty">Loading monitors…</div>
              ) : monitors.length === 0 ? (
                <div className="team-empty">
                  No monitors yet.
                  {hasRequests
                    ? ' Create one below to run a request on a schedule.'
                    : ' This workspace has no requests to monitor.'}
                </div>
              ) : (
                <ul className="monitor-list">
                  {monitors.map((monitor) => {
                    const option = optionsById[monitor.requestId];
                    const latest = latestRuns[monitor.id];
                    const run = summarizeRun(latest);
                    const busy = runningId === monitor.id || deletingId === monitor.id;
                    return (
                      <li key={monitor.id} className="monitor-item">
                        <div className="monitor-row">
                          <div className="monitor-main">
                            <div className="monitor-title">
                              <span className="monitor-name">
                                {monitor.name || 'Untitled monitor'}
                              </span>
                              <span
                                className={`monitor-state ${monitor.enabled ? 'on' : 'off'}`}
                              >
                                {monitor.enabled ? 'Enabled' : 'Paused'}
                              </span>
                            </div>
                            <div className="monitor-meta">
                              <span title={monitor.requestId || ''}>
                                {option
                                  ? requestOptionLabel(option)
                                  : `Request ${shortId(monitor.requestId) || 'unknown'}`}
                              </span>
                              <span>{cronLabel(monitor.cron)}</span>
                              <span>Next: {formatNextRun(monitor.nextRunAt)}</span>
                              <span>Last: {formatLastRun(monitor.lastRunAt)}</span>
                            </div>
                            <div className="monitor-last">
                              {latest ? (
                                <span
                                  className={`monitor-run-badge ${run.ok ? 'ok' : 'fail'}`}
                                  title={run.error || run.summary}
                                >
                                  {run.summary}
                                </span>
                              ) : (
                                <span className="monitor-run-badge idle">No runs yet</span>
                              )}
                            </div>
                          </div>
                          <div className="monitor-actions">
                            {canMutate && (
                              <label
                                className="monitor-switch"
                                title="Enable or pause this monitor"
                              >
                                <input
                                  type="checkbox"
                                  checked={Boolean(monitor.enabled)}
                                  disabled={togglingId === monitor.id || busy}
                                  onChange={() => toggleEnabled(monitor)}
                                  aria-label={`Enable monitor ${monitor.name || 'Untitled monitor'}`}
                                />
                                <span>{monitor.enabled ? 'On' : 'Off'}</span>
                              </label>
                            )}
                            {canMutate && (
                              <button
                                type="button"
                                className="mini-btn"
                                onClick={() => runNow(monitor)}
                                disabled={busy || runningId === monitor.id}
                              >
                                {runningId === monitor.id ? 'Running…' : 'Run now'}
                              </button>
                            )}
                            <button
                              type="button"
                              className="mini-btn"
                              onClick={() => toggleHistory(monitor)}
                              disabled={deletingId === monitor.id}
                            >
                              {expandedId === monitor.id ? 'Hide history' : 'History'}
                            </button>
                            {canMutate && (
                              <button
                                type="button"
                                className="icon-btn monitor-delete"
                                title="Delete monitor"
                                aria-label={`Delete monitor ${monitor.name || 'Untitled monitor'}`}
                                onClick={() => removeMonitor(monitor)}
                                disabled={busy}
                              >
                                <Icon name="trash" size={13} />
                              </button>
                            )}
                          </div>
                        </div>
                        {expandedId === monitor.id && (
                          <RunHistory state={histories[monitor.id]} />
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {canMutate && (
              <section className="team-section">
                <div className="team-section-head">
                  <span className="team-section-title">Create monitor</span>
                </div>
                {!hasRequests ? (
                  <div className="team-empty">
                    No requests in this workspace to monitor. Add a request to a collection
                    first.
                  </div>
                ) : (
                  <form className="monitor-form" onSubmit={createMonitor}>
                    <div className="monitor-form-grid">
                      <div className="form-row">
                        <label htmlFor="monitor-name">Name</label>
                        <input
                          id="monitor-name"
                          type="text"
                          value={form.name}
                          placeholder="Checkout smoke test"
                          disabled={creating}
                          onChange={(event) =>
                            setForm((prev) => ({ ...prev, name: event.target.value }))
                          }
                        />
                      </div>
                      <div className="form-row">
                        <label htmlFor="monitor-request">Request</label>
                        <select
                          id="monitor-request"
                          value={form.requestId}
                          disabled={creating}
                          onChange={(event) => chooseRequest(event.target.value)}
                        >
                          <option value="">Select a request…</option>
                          {requestOptions.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.method} · {requestOptionLabel(option)}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="monitor-form-grid">
                      <div className="form-row">
                        <label htmlFor="monitor-cron">Schedule</label>
                        <select
                          id="monitor-cron"
                          value={form.cronPreset}
                          disabled={creating}
                          onChange={(event) =>
                            setForm((prev) => ({ ...prev, cronPreset: event.target.value }))
                          }
                        >
                          {CRON_PRESETS.map((preset) => (
                            <option key={preset.value} value={preset.value}>
                              {preset.label}
                            </option>
                          ))}
                          <option value={CUSTOM_CRON}>Custom cron…</option>
                        </select>
                      </div>
                      <div className="form-row">
                        <label htmlFor="monitor-webhook">Alert webhook (optional)</label>
                        <input
                          id="monitor-webhook"
                          type="url"
                          value={form.alertWebhook}
                          placeholder="https://hooks.example.com/relay"
                          disabled={creating}
                          onChange={(event) =>
                            setForm((prev) => ({ ...prev, alertWebhook: event.target.value }))
                          }
                        />
                      </div>
                    </div>

                    {form.cronPreset === CUSTOM_CRON && (
                      <div className="form-row">
                        <label htmlFor="monitor-cron-custom">Custom cron expression</label>
                        <input
                          id="monitor-cron-custom"
                          type="text"
                          value={form.customCron}
                          placeholder="*/15 * * * *"
                          disabled={creating}
                          onChange={(event) =>
                            setForm((prev) => ({ ...prev, customCron: event.target.value }))
                          }
                        />
                      </div>
                    )}

                    <div className="monitor-form-actions">
                      <label className="monitor-check">
                        <input
                          type="checkbox"
                          checked={form.enabled}
                          disabled={creating}
                          onChange={(event) =>
                            setForm((prev) => ({ ...prev, enabled: event.target.checked }))
                          }
                        />
                        Enabled
                      </label>
                      <button
                        type="submit"
                        className="mini-btn primary"
                        disabled={creating}
                      >
                        {creating ? 'Creating…' : 'Create monitor'}
                      </button>
                    </div>
                  </form>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
