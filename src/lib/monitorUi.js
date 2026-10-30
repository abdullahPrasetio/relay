// Pure helpers for the scheduled-monitor UI. Kept free of React and of the
// cloud bridge so request flattening, cron labels, and run summaries stay
// unit testable without Electron.

import { formatDateTime, formatRelativeTime } from './deviceUi.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const CRON_PRESETS = Object.freeze([
  Object.freeze({ value: '*/5 * * * *', label: 'Every 5 minutes' }),
  Object.freeze({ value: '0 * * * *', label: 'Hourly' }),
  Object.freeze({ value: '0 9 * * *', label: 'Daily at 09:00 UTC' }),
]);

/** Roles that may create, edit, run, or delete monitors. */
const MONITOR_WRITE_ROLES = Object.freeze(['owner', 'admin', 'editor']);

/**
 * Whether the caller can mutate monitors. When the role is unavailable the
 * controls stay visible and the server enforces the real permission check; a
 * known viewer is read-only.
 */
export function canManageMonitors(role) {
  if (role === undefined || role === null || role === '') return true;
  return MONITOR_WRITE_ROLES.includes(String(role));
}

/** Friendly label for a cron expression; custom expressions stay verbatim. */
export function cronLabel(expression) {
  if (typeof expression !== 'string' || !expression.trim()) return 'No schedule';
  const value = expression.trim();
  const preset = CRON_PRESETS.find((entry) => entry.value === value);
  return preset ? preset.label : value;
}

/**
 * Flatten a local workspace's collection tree into request options. Accepts
 * either a workspace (`{ collections }`) or the collections array itself.
 * Folders contribute to the breadcrumb; only request nodes are returned.
 */
export function flattenWorkspaceRequests(source) {
  const collections = Array.isArray(source)
    ? source
    : Array.isArray(source?.collections)
      ? source.collections
      : [];
  const options = [];

  const walk = (items, ancestors, collectionId) => {
    for (const node of items || []) {
      if (!node || typeof node !== 'object') continue;
      const name =
        typeof node.name === 'string' && node.name.trim() ? node.name.trim() : 'Untitled';
      if (node.type === 'folder') {
        walk(node.items, [...ancestors, name], collectionId);
        continue;
      }
      const breadcrumb = ancestors.join(' / ');
      const id = node.id == null ? '' : String(node.id);
      if (!id) continue;
      options.push({
        id,
        name,
        method: typeof node.method === 'string' && node.method ? node.method : 'GET',
        collectionId: collectionId == null ? '' : String(collectionId),
        breadcrumb,
        path: breadcrumb ? `${breadcrumb} / ${name}` : name,
      });
    }
  };

  for (const collection of collections) {
    if (!collection || typeof collection !== 'object') continue;
    const collectionName =
      typeof collection.name === 'string' && collection.name.trim()
        ? collection.name.trim()
        : 'Collection';
    const items = Array.isArray(collection.items)
      ? collection.items
      : Array.isArray(collection.requests)
        ? collection.requests.map((request) => ({ ...request, type: 'request' }))
        : [];
    walk(items, [collectionName], collection.id);
  }

  return options;
}

/** Compact label for a request option (falls back to the bare name). */
export function requestOptionLabel(option) {
  if (!option) return 'Unknown request';
  return option.path || option.name || 'Untitled request';
}

function timestampOf(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) return new Date(value).getTime();
  return NaN;
}

/** "in 5m" / "due now" / a UTC date for far-future schedules. */
export function formatNextRun(value, now = Date.now()) {
  const time = timestampOf(value);
  if (!Number.isFinite(time)) return 'Not scheduled';
  const nowMs = timestampOf(now);
  const reference = Number.isFinite(nowMs) ? nowMs : Date.now();
  const diff = time - reference;

  if (diff <= 0) return 'due now';
  if (diff < MINUTE) return 'in <1m';
  if (diff < HOUR) return `in ${Math.max(1, Math.round(diff / MINUTE))}m`;
  if (diff < DAY) return `in ${Math.max(1, Math.round(diff / HOUR))}h`;
  if (diff < 7 * DAY) return `in ${Math.max(1, Math.round(diff / DAY))}d`;
  return formatDateTime(time) || 'Not scheduled';
}

/** "Never" or a relative last-run label. */
export function formatLastRun(value, now = Date.now()) {
  const time = timestampOf(value);
  if (!Number.isFinite(time)) return 'Never';
  const label = formatRelativeTime(time, now);
  return label || 'Never';
}

/** Compact duration: 123ms, 1.5s, 1m 5s, 1h 2m. */
export function formatDuration(value) {
  if (value === null || value === undefined || value === '') return '—';
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < MINUTE) {
    const seconds = ms / 1000;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
  }
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

/**
 * Presentation model for one run. `status` is human-facing; the raw HTTP
 * status remains available as `statusCode`.
 */
export function summarizeRun(run) {
  if (!run || typeof run !== 'object') {
    return {
      ok: false,
      status: 'No runs yet',
      statusCode: null,
      durationMs: null,
      duration: '—',
      assertions: 0,
      assertionsLabel: '',
      summary: 'No runs yet',
      startedAt: null,
      finishedAt: null,
      error: '',
    };
  }

  const ok = run.ok === true;
  const statusCode =
    run.statusCode === undefined || run.statusCode === null || run.statusCode === ''
      ? null
      : Number(run.statusCode);
  const hasCode = Number.isFinite(statusCode);
  const durationMs = Number(run.durationMs);
  const hasDuration = Number.isFinite(durationMs) && durationMs >= 0;
  const assertions = Number.isFinite(Number(run.assertionFailures))
    ? Math.max(0, Math.floor(Number(run.assertionFailures)))
    : 0;
  const status = ok ? 'Passed' : 'Failed';
  const duration = hasDuration ? formatDuration(durationMs) : '—';
  const assertionsLabel =
    assertions === 1 ? '1 assertion failed' : `${assertions} assertions failed`;

  const parts = [status];
  if (hasCode) parts.push(String(statusCode));
  if (hasDuration) parts.push(duration);
  if (assertions) parts.push(assertionsLabel);

  return {
    ok,
    status,
    statusCode: hasCode ? statusCode : null,
    durationMs: hasDuration ? durationMs : null,
    duration,
    assertions,
    assertionsLabel,
    summary: parts.join(' · '),
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    error: typeof run.error === 'string' ? run.error : '',
  };
}

/** The bridge already unwraps `{data}`; accept array and `{runs}` shapes too. */
export function normalizeRuns(payload) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.runs)
      ? payload.runs
      : Array.isArray(payload?.data)
        ? payload.data
        : [];
  return list.filter((run) => run && typeof run === 'object');
}
