// Pure helpers for the Relay Cloud device and conflict UI. Kept free of React
// and of the cloud bridge so formatting and payload normalisation stay unit
// testable without Electron.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const CONFLICT_KINDS = Object.freeze({
  collection: 'Collection',
  folder: 'Folder',
  request: 'Request',
  environment: 'Environment',
  globals: 'Globals',
});

function pad(value) {
  return String(value).padStart(2, '0');
}

function timestampOf(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) return new Date(value).getTime();
  return NaN;
}

/** Trim an opaque id for display without leaking a long uuid. */
export function shortId(value, length = 8) {
  if (value === undefined || value === null) return '';
  const id = String(value).trim();
  if (!id) return '';
  return id.length <= length ? id : id.slice(0, length);
}

/** "2026-10-30 12:04 UTC"; empty string when the value cannot be parsed. */
export function formatDateTime(value) {
  const time = timestampOf(value);
  if (!Number.isFinite(time)) return '';
  const date = new Date(time);
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}

/**
 * Compact relative time ("just now", "5m ago", "3d ago") that falls back to a
 * UTC date once the value is more than a week old.
 */
export function formatRelativeTime(value, now = Date.now()) {
  const time = timestampOf(value);
  if (!Number.isFinite(time)) return '';
  const nowMs = timestampOf(now);
  const reference = Number.isFinite(nowMs) ? nowMs : Date.now();
  const elapsed = Math.max(0, reference - time);

  if (elapsed < 45 * 1000) return 'just now';
  if (elapsed < HOUR) return `${Math.max(1, Math.floor(elapsed / MINUTE))}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d ago`;
  return formatDateTime(time);
}

/** Human label for a device; empty labels get a stable placeholder. */
export function formatDeviceLabel(device) {
  const value =
    typeof device === 'string'
      ? device
      : device?.deviceLabel ?? device?.device_label ?? device?.label ?? '';
  const label = typeof value === 'string' ? value.trim() : '';
  return label || 'Unnamed device';
}

/**
 * One line describing activity: last use when the server knows it, otherwise
 * creation time, otherwise a neutral fallback.
 */
export function formatDeviceActivity(device, now = Date.now()) {
  const lastUsed = device?.lastUsedAt ?? device?.last_used_at ?? null;
  if (lastUsed) {
    const relative = formatRelativeTime(lastUsed, now);
    if (relative) return `Last used ${relative}`;
  }
  const created = device?.createdAt ?? device?.created_at ?? null;
  const relative = formatRelativeTime(created, now);
  if (relative) return `Added ${relative}`;
  return 'Activity unknown';
}

/** Kind label for a sync conflict, humanizing unknown kinds. */
export function conflictKindLabel(kind) {
  if (typeof kind !== 'string' || !kind.trim()) return 'Change';
  const key = kind.trim().toLowerCase();
  if (CONFLICT_KINDS[key]) return CONFLICT_KINDS[key];
  const words = key.replace(/[._:-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Change';
}

function payloadOf(side) {
  return side && typeof side === 'object' && side.payload && typeof side.payload === 'object'
    ? side.payload
    : null;
}

/** Display name of the conflicting entity, or a short id fallback. */
export function conflictName(conflict) {
  const local = payloadOf(conflict?.local);
  const server = payloadOf(conflict?.server);
  const name = local?.name ?? server?.name;
  if (typeof name === 'string' && name.trim()) return name.trim();
  if (conflict?.kind === 'globals') return 'Globals';
  const id = shortId(conflict?.id);
  return id ? `Change ${id}` : 'Untitled change';
}

/**
 * `Request "List users"` plus deletion notes for either side, so a row reads
 * without looking up the ids in the banner.
 */
export function describeConflict(conflict) {
  const parts = [`${conflictKindLabel(conflict?.kind)} “${conflictName(conflict)}”`];
  const notes = [];
  if (conflict?.local?.deleted) notes.push('deleted locally');
  if (conflict?.server?.deleted) notes.push('deleted on server');
  if (notes.length) parts.push(`(${notes.join(', ')})`);
  return parts.join(' ');
}

/** "No conflicts" / "1 conflict" / "4 conflicts". */
export function conflictSummary(value) {
  const count = Array.isArray(value) ? value.length : Math.max(0, Math.trunc(Number(value) || 0));
  if (count === 0) return 'No conflicts';
  return count === 1 ? '1 conflict' : `${count} conflicts`;
}

/**
 * Normalise the `/auth/devices` payload. The desktop client already unwraps
 * the API envelope, but accepting `{devices: [...]}` and snake_case fields
 * keeps the modal working against older bridges.
 */
export function normalizeDevices(payload) {
  let list = payload;
  if (payload && !Array.isArray(payload) && typeof payload === 'object') {
    list = payload.devices ?? payload.sessions ?? payload.items ?? [];
  }
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const devices = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const id = entry.id ?? entry.deviceId ?? entry.device_id;
    if (id === undefined || id === null || String(id).trim() === '') continue;
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    devices.push({
      id: key,
      deviceLabel: formatDeviceLabel(entry),
      createdAt: entry.createdAt ?? entry.created_at ?? null,
      lastUsedAt: entry.lastUsedAt ?? entry.last_used_at ?? null,
      expiresAt: entry.expiresAt ?? entry.expires_at ?? null,
    });
  }
  return devices;
}
