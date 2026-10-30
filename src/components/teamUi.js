// Pure helpers for the workspace team and audit UI. Kept free of React and
// of the cloud bridge so the role matrix and formatting rules are unit
// testable without Electron.

export const WORKSPACE_ROLES = Object.freeze(['owner', 'admin', 'editor', 'viewer']);

export const ROLE_LABELS = Object.freeze({
  owner: 'Owner',
  admin: 'Admin',
  editor: 'Editor',
  viewer: 'Viewer',
});

const MANAGER_ROLES = Object.freeze(['owner', 'admin']);
const INVITE_ROLES = Object.freeze({
  owner: ['owner', 'admin', 'editor', 'viewer'],
  admin: ['admin', 'editor', 'viewer'],
});

const AUDIT_ACTIONS = Object.freeze({
  'member.invited': 'Invited member',
  'member.joined': 'Member joined',
  'member.role_changed': 'Changed member role',
  'member.removed': 'Removed member',
  'invite.created': 'Created invite',
  'invite.revoked': 'Revoked invite',
  'workspace.created': 'Created workspace',
  'workspace.renamed': 'Renamed workspace',
  'workspace.deleted': 'Deleted workspace',
  'change.pushed': 'Pushed changes',
  'change.pulled': 'Pulled changes',
});

export function isManagerRole(role) {
  return MANAGER_ROLES.includes(role);
}

/** Roles the caller may hand out; `[]` for non-managers. */
export function assignableRoles(callerRole) {
  return INVITE_ROLES[callerRole] ? [...INVITE_ROLES[callerRole]] : [];
}

export function canAssignRole(callerRole, role) {
  return assignableRoles(callerRole).includes(role);
}

/**
 * Whether the caller may change/remove this member. Managers never edit
 * themselves, and only owners may touch an existing owner.
 */
export function canManageMember(callerRole, member, currentUserId) {
  if (!isManagerRole(callerRole)) return false;
  if (!member || typeof member !== 'object') return false;
  if (currentUserId && member.userId === currentUserId) return false;
  if (member.role === 'owner' && callerRole !== 'owner') return false;
  return true;
}

/** Trim an opaque id for display without leaking a long uuid. */
export function shortId(value, length = 8) {
  if (value === undefined || value === null) return '';
  const id = String(value).trim();
  if (!id) return '';
  return id.length <= length ? id : id.slice(0, length);
}

/** Human label for an audit `action`; unknown actions are humanized. */
export function formatAuditAction(action) {
  if (typeof action !== 'string' || !action.trim()) return 'Unknown action';
  const key = action.trim();
  if (AUDIT_ACTIONS[key]) return AUDIT_ACTIONS[key];
  const words = key.replace(/[._:-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!words) return 'Unknown action';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function timestampOf(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) return new Date(value).getTime();
  return NaN;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

/**
 * Compact, deterministic age label. Older than a week falls back to a UTC
 * timestamp so events remain readable without locale-specific formatting.
 */
export function formatAuditTimestamp(value, now = Date.now()) {
  const time = timestampOf(value);
  if (!Number.isFinite(time)) return '';
  const nowMs = timestampOf(now);
  const reference = Number.isFinite(nowMs) ? nowMs : Date.now();
  const seconds = Math.max(0, Math.floor((reference - time) / 1000));

  if (seconds < 45) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  const date = new Date(time);
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}

/** Display form for an audit `target` (id, name, or nested object). */
export function formatAuditTarget(target) {
  if (target === undefined || target === null || target === '') return '—';
  if (typeof target === 'string' || typeof target === 'number') return String(target);
  if (typeof target === 'object') {
    const id = target.id ?? target.userId ?? target.entityId ?? target.collectionId;
    if (id !== undefined && id !== null && id !== '') return String(id);
    const label = target.name ?? target.email ?? target.label;
    if (label) return String(label);
  }
  return '—';
}

/** Merge audit pages, de-duplicating by id and keeping newest first. */
export function mergeAuditEvents(existing, incoming) {
  const byId = new Map();
  for (const event of [...(existing || []), ...(incoming || [])]) {
    if (!event || event.id === undefined || event.id === null) continue;
    byId.set(String(event.id), event);
  }
  return [...byId.values()].sort((a, b) => {
    const aTime = timestampOf(a.createdAt);
    const bTime = timestampOf(b.createdAt);
    const aSafe = Number.isFinite(aTime) ? aTime : 0;
    const bSafe = Number.isFinite(bTime) ? bTime : 0;
    if (aSafe !== bSafe) return bSafe - aSafe;
    const aId = Number(a.id);
    const bId = Number(b.id);
    if (Number.isFinite(aId) && Number.isFinite(bId) && aId !== bId) return bId - aId;
    return String(b.id).localeCompare(String(a.id));
  });
}

/** Turn the API's relative accept path into an absolute link when possible. */
export function buildInviteLink(acceptPath, origin = '') {
  if (typeof acceptPath !== 'string' || !acceptPath.trim()) return '';
  const target = acceptPath.trim();
  if (/^https?:\/\//i.test(target)) return target;
  if (!/^https?:\/\//i.test(String(origin || ''))) return target;
  return `${String(origin).replace(/\/+$/, '')}/${target.replace(/^\/+/, '')}`;
}
