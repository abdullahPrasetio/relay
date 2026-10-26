// Open-tab session persistence.
//
// A session is a deliberately lossy snapshot of the workspace UI: the open
// tabs (plus their request snapshots), the active tab, and the visible rail
// panel. Responses, test results and in-flight state are transient and are
// never stored. Request snapshots are only a fallback: saved requests are
// re-read from the collection tree on restore so external/stale snapshots do
// not resurrect old data.
//
// This module is pure (no React, no DOM) so the restore rules can be tested in
// Node; the caller owns localStorage access.

export const SESSION_KEY = 'relay-session';
export const SESSION_VERSION = 1;

const RAIL_VIEWS = new Set(['collections', 'environments', 'history']);

// Depth-first lookup of a request node (folders are nodes with `items`).
function findInItems(items, requestId) {
  if (!Array.isArray(items)) return null;
  for (const node of items) {
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node.items)) {
      // Processes may be legacy flat entries; never treat a container as a match.
      const nested = findInItems(node.items, requestId);
      if (nested) return nested;
      continue;
    }
    if (node.id === requestId) return node;
  }
  return null;
}

// Resolve a request id anywhere in the collection tree.
// Returns `{ collection, request }` or null. Supports the pre-tree
// `collection.requests[]` shape so callers do not need to normalize first.
export function findRequestById(collections, requestId) {
  if (!requestId || !Array.isArray(collections)) return null;
  for (const collection of collections) {
    if (!collection || typeof collection !== 'object') continue;
    const request =
      findInItems(collection.items, requestId) ||
      findInItems(collection.requests, requestId);
    if (request) return { collection, request };
  }
  return null;
}

// Build the persisted payload. Transient tab fields (response, testResults,
// sending, sendingId) are not part of the shape at all.
export function serializeSession({ tabs, activeTabId, railView } = {}) {
  const entries = (Array.isArray(tabs) ? tabs : [])
    .filter((tab) => tab && tab.request && typeof tab.request === 'object')
    .map((tab) => ({
      tabId: tab.tabId,
      requestId: tab.request.id || null,
      request: tab.request,
      dirty: !!tab.dirty,
      savedCollectionId: tab.savedCollectionId ?? null,
    }));

  const active =
    entries.find((entry) => entry.tabId === activeTabId)?.tabId ||
    entries[0]?.tabId ||
    null;

  return {
    version: SESSION_VERSION,
    tabs: entries,
    activeTabId: active,
    railView: RAIL_VIEWS.has(railView) ? railView : 'collections',
  };
}

function parseSession(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      return parseSession(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw;
}

// Rebuild tabs from a stored session.
//
// `makeTab(request)` is supplied by the app so this module stays free of UI
// state. Returns `{ tabs, activeTabId, railView }`, or null when the payload is
// unusable (wrong version, unparseable, or no tabs at all).
export function restoreSession(raw, { collections, makeTab } = {}) {
  if (typeof makeTab !== 'function') return null;
  const data = parseSession(raw);
  if (!data || data.version !== SESSION_VERSION) return null;
  if (!Array.isArray(data.tabs) || data.tabs.length === 0) return null;

  const list = Array.isArray(collections) ? collections : [];
  const tabs = [];
  const seenRequests = new Set();
  const seenTabIds = new Set();

  for (const entry of data.tabs) {
    if (!entry || typeof entry !== 'object') continue;
    const snapshot =
      entry.request && typeof entry.request === 'object' ? entry.request : null;
    const requestId =
      (typeof entry.requestId === 'string' && entry.requestId) ||
      (typeof snapshot?.id === 'string' && snapshot.id) ||
      null;

    // Saved requests win over their stored snapshot (fresh name/url/scripts).
    const found = requestId ? findRequestById(list, requestId) : null;
    const request = found?.request || snapshot;
    if (!request) continue;

    const key = request.id || `tab:${entry.tabId}`;
    if (seenRequests.has(key)) continue;
    seenRequests.add(key);

    const tab = makeTab(request);
    if (
      typeof entry.tabId === 'string' &&
      entry.tabId &&
      !seenTabIds.has(entry.tabId)
    ) {
      tab.tabId = entry.tabId;
    }
    seenTabIds.add(tab.tabId);

    tab.savedCollectionId =
      found?.collection?.id ?? entry.savedCollectionId ?? null;
    // A request resolved from the tree has no local edits to lose; a snapshot
    // keeps its dirty marker so the unsaved-changes guard still applies.
    tab.dirty = found ? false : !!entry.dirty;
    tabs.push(tab);
  }

  // Never hand back an empty tab strip: the app would have nothing to render.
  if (tabs.length === 0) {
    const fallback = makeTab();
    return {
      tabs: [fallback],
      activeTabId: fallback.tabId,
      railView: RAIL_VIEWS.has(data.railView) ? data.railView : 'collections',
    };
  }

  const activeTabId = tabs.some((tab) => tab.tabId === data.activeTabId)
    ? data.activeTabId
    : tabs[0].tabId;

  return {
    tabs,
    activeTabId,
    railView: RAIL_VIEWS.has(data.railView) ? data.railView : 'collections',
  };
}
