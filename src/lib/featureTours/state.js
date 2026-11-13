// Local-only bookkeeping for feature tours. This is a UI preference, not
// workspace content: it never goes through the cloud sync or the encrypted
// workspace file. Reads and writes are best-effort so a disabled localStorage
// can never block startup.
export const TOUR_STORAGE_KEY = 'relay-feature-tours-v1';
export const TOUR_SCHEMA_VERSION = 2;

export function emptyTourState() {
  return {
    schemaVersion: TOUR_SCHEMA_VERSION,
    lastAppVersion: '0.0.0',
    enabled: true,
    seen: {},
  };
}

function storageOrNull(storage) {
  if (storage) return storage;
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

function cleanVersion(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function compareVersions(a, b) {
  const parse = (value) => {
    const clean = cleanVersion(value).replace(/^v/i, '');
    const [core, prerelease = ''] = clean.split('+', 1)[0].split('-', 2);
    return {
      core: core.split('.').map((part) => {
        const number = Number.parseInt(part, 10);
        return Number.isFinite(number) ? number : 0;
      }),
      prerelease: prerelease ? prerelease.split('.') : [],
    };
  };
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.core.length, right.core.length);
  for (let i = 0; i < length; i += 1) {
    const x = left.core[i] || 0;
    const y = right.core[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const preLength = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < preLength; i += 1) {
    const x = left.prerelease[i];
    const y = right.prerelease[i];
    if (x == null) return -1;
    if (y == null) return 1;
    const nx = Number.parseInt(x, 10);
    const ny = Number.parseInt(y, 10);
    const xNumeric = Number.isFinite(nx) && String(nx) === x;
    const yNumeric = Number.isFinite(ny) && String(ny) === y;
    if (xNumeric && yNumeric && nx !== ny) return nx > ny ? 1 : -1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** Normalize anything read from disk into the shape the hook expects. */
export function normalizeTourState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyTourState();
  const seen = {};
  const source = raw.seen && typeof raw.seen === 'object' && !Array.isArray(raw.seen)
    ? raw.seen
    : {};
  for (const [id, entry] of Object.entries(source)) {
    if (!id || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const action = entry.action === 'skipped' ? 'skipped' : 'completed';
    seen[id] = {
      action,
      version: cleanVersion(entry.version),
      at: typeof entry.at === 'string' ? entry.at : '',
    };
  }
  // Schema 1 baseline-marked the Feature Guide announcement as seen even
  // though the beta builds never showed it. Re-open that announcement once;
  // schema 2 keeps normal seen/skipped behavior.
  if ((Number(raw.schemaVersion) || 1) < 2) delete seen['help.featureGuide'];
  return {
    schemaVersion: TOUR_SCHEMA_VERSION,
    lastAppVersion: cleanVersion(raw.lastAppVersion) || '0.0.0',
    enabled: raw.enabled !== false,
    seen,
  };
}

/** Returns `{ state, exists, error }`; a corrupt value is treated as absent. */
export function loadTourState(storage) {
  const store = storageOrNull(storage);
  if (!store) return { state: emptyTourState(), exists: false, error: true };
  try {
    const raw = store.getItem(TOUR_STORAGE_KEY);
    if (!raw) return { state: emptyTourState(), exists: false, error: false };
    return { state: normalizeTourState(JSON.parse(raw)), exists: true, error: false };
  } catch {
    return { state: emptyTourState(), exists: false, error: true };
  }
}

export function writeTourState(state, storage) {
  const store = storageOrNull(storage);
  if (!store) return false;
  try {
    store.setItem(TOUR_STORAGE_KEY, JSON.stringify(normalizeTourState(state)));
    return true;
  } catch {
    return false;
  }
}

export function markSeen(state, ids, action = 'completed', version = '') {
  const next = normalizeTourState(state);
  const now = new Date().toISOString();
  for (const id of ids || []) {
    if (!id) continue;
    next.seen[id] = {
      action: action === 'skipped' ? 'skipped' : 'completed',
      version: cleanVersion(version),
      at: now,
    };
  }
  return next;
}

export function markAllSeen(state, features, action = 'skipped', version = '') {
  return markSeen(state, (features || []).map((feature) => feature?.id), action, version);
}

export function resetTourState() {
  return { ...emptyTourState(), lastAppVersion: '0.0.0' };
}
