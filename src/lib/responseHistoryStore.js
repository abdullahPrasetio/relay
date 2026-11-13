// Persisted, size-capped response history for the diff tab.
//
// Responses are kept outside the workspace JSON because bodies can be large;
// localStorage is renderer-only and never synced. Each request keeps at most
// 10 previous responses, each body capped at 128 KiB.

const PREFIX = 'relay-response-history:';
const MAX_ENTRIES = 10;
const MAX_BODY_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

function keyFor(workspaceId) {
  return `${PREFIX}${workspaceId || 'default'}`;
}

function readMap(workspaceId) {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(keyFor(workspaceId));
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function trimEntries(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      ...entry,
      body:
        typeof entry.body === 'string' && entry.body.length > MAX_BODY_BYTES
          ? entry.body.slice(0, MAX_BODY_BYTES)
          : entry.body,
    }))
    .slice(-MAX_ENTRIES);
}

function trimTotal(map) {
  let serialized = JSON.stringify(map);
  while (serialized.length > MAX_TOTAL_BYTES) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [requestId, entries] of Object.entries(map)) {
      for (const entry of entries || []) {
        if (Number(entry.at) < oldestAt) {
          oldestAt = Number(entry.at);
          oldestKey = requestId;
        }
      }
    }
    if (!oldestKey || !Array.isArray(map[oldestKey])) break;
    map[oldestKey] = map[oldestKey].slice(1);
    if (map[oldestKey].length === 0) delete map[oldestKey];
    serialized = JSON.stringify(map);
  }
  return map;
}

export function loadResponseHistory(workspaceId, requestId) {
  if (!requestId) return [];
  return trimEntries(readMap(workspaceId)[requestId]);
}

export function saveResponseHistory(workspaceId, requestId, entries) {
  if (!requestId) return;
  try {
    if (typeof localStorage === 'undefined') return;
    const map = readMap(workspaceId);
    const next = trimEntries(entries);
    if (next.length === 0) delete map[requestId];
    else map[requestId] = next;
    trimTotal(map);
    localStorage.setItem(keyFor(workspaceId), JSON.stringify(map));
  } catch {
    /* storage full/unavailable: history is best-effort */
  }
}

export function clearResponseHistory(workspaceId, requestId) {
  saveResponseHistory(workspaceId, requestId, []);
}
