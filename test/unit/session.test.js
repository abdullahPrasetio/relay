import { describe, expect, it } from 'vitest';
import {
  SESSION_KEY,
  SESSION_VERSION,
  findRequestById,
  restoreSession,
  serializeSession,
} from '../../src/lib/session.js';
import { normalizeRequest } from '../../src/lib/factory.js';

let tabCounter = 0;

// Mirrors App's newTab: every restore resets transient fields through here.
function makeTab(request) {
  tabCounter += 1;
  return {
    tabId: `tab_${tabCounter}`,
    request: normalizeRequest(request || {}),
    response: null,
    testResults: null,
    sending: false,
    sendingId: null,
    dirty: false,
    savedCollectionId: null,
  };
}

const collections = [
  {
    id: 'col_1',
    name: 'API',
    items: [
      {
        id: 'folder_1',
        type: 'folder',
        name: 'Nested',
        items: [
          {
            id: 'req_saved',
            type: 'request',
            name: 'Saved (current)',
            method: 'GET',
            url: 'https://saved.example/fresh',
            params: [],
            headers: [],
          },
        ],
      },
    ],
  },
];

describe('serializeSession', () => {
  it('stores a versioned tab snapshot without transient fields', () => {
    const savedTab = {
      tabId: 'tab_saved',
      request: {
        id: 'req_saved',
        name: 'Stale snapshot',
        method: 'GET',
        url: 'https://stale.example',
      },
      response: { ok: true, status: 200 },
      testResults: { ran: true, results: [] },
      sending: true,
      sendingId: 'req_uuid',
      dirty: false,
      savedCollectionId: 'col_1',
    };
    const draftTab = {
      tabId: 'tab_draft',
      request: { id: 'req_draft', name: 'Draft', method: 'POST', url: 'https://draft.example' },
      response: null,
      testResults: null,
      sending: false,
      sendingId: null,
      dirty: true,
      savedCollectionId: null,
    };

    const payload = serializeSession({
      tabs: [savedTab, draftTab],
      activeTabId: 'tab_draft',
      railView: 'history',
    });

    expect(payload.version).toBe(SESSION_VERSION);
    expect(payload.activeTabId).toBe('tab_draft');
    expect(payload.railView).toBe('history');
    expect(payload.tabs).toEqual([
      {
        tabId: 'tab_saved',
        requestId: 'req_saved',
        request: savedTab.request,
        dirty: false,
        savedCollectionId: 'col_1',
      },
      {
        tabId: 'tab_draft',
        requestId: 'req_draft',
        request: draftTab.request,
        dirty: true,
        savedCollectionId: null,
      },
    ]);
    expect(payload.tabs[0]).not.toHaveProperty('response');
    expect(payload.tabs[0]).not.toHaveProperty('testResults');
    expect(payload.tabs[0]).not.toHaveProperty('sending');
  });

  it('falls back to the first tab when the active id is unknown', () => {
    const payload = serializeSession({
      tabs: [{ tabId: 'a', request: { id: 'req_a' }, dirty: false }],
      activeTabId: 'missing',
      railView: 'bogus',
    });
    expect(payload.activeTabId).toBe('a');
    expect(payload.railView).toBe('collections');
  });
});

describe('restoreSession', () => {
  it('round-trips two tabs: saved from the tree, unsaved from the snapshot', () => {
    const tabs = [
      {
        tabId: 'tab_saved',
        request: {
          id: 'req_saved',
          name: 'Stale snapshot',
          method: 'GET',
          url: 'https://stale.example',
        },
        dirty: false,
        savedCollectionId: 'col_1',
      },
      {
        tabId: 'tab_draft',
        request: {
          id: 'req_draft',
          name: 'Draft',
          method: 'POST',
          url: 'https://draft.example',
        },
        dirty: true,
        savedCollectionId: null,
      },
    ];

    // Go through JSON to mimic localStorage.
    const stored = JSON.parse(
      JSON.stringify(
        serializeSession({ tabs, activeTabId: 'tab_draft', railView: 'environments' })
      )
    );

    const restored = restoreSession(stored, { collections, makeTab });
    expect(restored).not.toBeNull();
    expect(restored.tabs).toHaveLength(2);
    expect(restored.activeTabId).toBe('tab_draft');
    expect(restored.railView).toBe('environments');

    const [saved, draft] = restored.tabs;
    // Saved request uses the fresh collection data, not the stored snapshot.
    expect(saved.tabId).toBe('tab_saved');
    expect(saved.request.id).toBe('req_saved');
    expect(saved.request.url).toBe('https://saved.example/fresh');
    expect(saved.savedCollectionId).toBe('col_1');
    expect(saved.dirty).toBe(false);

    // Unsaved draft falls back to its snapshot and keeps the dirty marker.
    expect(draft.tabId).toBe('tab_draft');
    expect(draft.request.url).toBe('https://draft.example');
    expect(draft.dirty).toBe(true);
    expect(draft.savedCollectionId).toBeNull();

    // Transient fields are never restored; a minimal makeTab proves restore
    // adds no send/response state of its own.
    const minimal = restoreSession(stored, {
      collections,
      makeTab: (request) => ({ tabId: `bare_${request.id}`, request }),
    });
    for (const tab of minimal.tabs) {
      expect(tab).not.toHaveProperty('sending');
      expect(tab).not.toHaveProperty('response');
      expect(tab).not.toHaveProperty('testResults');
    }

    // With the app's makeTab the transient fields are fresh defaults.
    for (const tab of restored.tabs) {
      expect(tab.response).toBeNull();
      expect(tab.testResults).toBeNull();
      expect(tab.sending).toBe(false);
    }
  });

  it('rejects wrong versions, unparseable input and empty tab lists', () => {
    const entry = {
      tabId: 't',
      requestId: 'req_saved',
      request: { id: 'req_saved' },
      dirty: false,
    };

    expect(
      restoreSession({ version: SESSION_VERSION + 1, tabs: [entry] }, { makeTab })
    ).toBeNull();
    expect(restoreSession('not json at all', { makeTab })).toBeNull();
    expect(restoreSession('null', { makeTab })).toBeNull();
    expect(restoreSession({ version: SESSION_VERSION, tabs: [] }, { makeTab })).toBeNull();
    expect(restoreSession(null, { makeTab })).toBeNull();
    expect(restoreSession({ version: SESSION_VERSION, tabs: [entry] }, {})).toBeNull();
  });

  it('deduplicates request ids and falls back when the active tab was dropped', () => {
    const stored = {
      version: SESSION_VERSION,
      activeTabId: 'gone',
      railView: 'history',
      tabs: [
        { tabId: 'a', request: { id: 'req_a', url: 'https://a.example' }, dirty: false },
        { tabId: 'b', request: { id: 'req_a', url: 'https://a.example' }, dirty: false },
        { tabId: 'c', request: { id: 'req_c', url: 'https://c.example' }, dirty: false },
      ],
    };

    const restored = restoreSession(stored, { makeTab });
    expect(restored.tabs.map((tab) => tab.tabId)).toEqual(['a', 'c']);
    expect(restored.activeTabId).toBe('a');
  });

  it('uses the snapshot when the saved request is gone, drops entries with neither', () => {
    const stored = {
      version: SESSION_VERSION,
      activeTabId: 'a',
      tabs: [
        {
          tabId: 'a',
          requestId: 'req_removed',
          request: { id: 'req_removed', url: 'https://kept.example' },
          dirty: true,
        },
        // No id in the tree and no snapshot: dropped.
        { tabId: 'b', requestId: 'req_missing' },
      ],
    };

    const restored = restoreSession(stored, { makeTab });
    expect(restored.tabs).toHaveLength(1);
    expect(restored.tabs[0].request.url).toBe('https://kept.example');
    expect(restored.tabs[0].dirty).toBe(true);
    expect(restored.activeTabId).toBe('a');
  });

  it('clamps to at least one tab when every entry is unusable', () => {
    const stored = {
      version: SESSION_VERSION,
      activeTabId: 'b',
      tabs: [{ tabId: 'b', requestId: 'req_missing' }],
    };

    const restored = restoreSession(stored, { makeTab });
    expect(restored.tabs).toHaveLength(1);
    expect(restored.activeTabId).toBe(restored.tabs[0].tabId);
    expect(restored.tabs[0].request.id).not.toBe('req_missing');
  });

  it('keeps the documented storage key stable', () => {
    expect(SESSION_KEY).toBe('relay-session');
    expect(SESSION_VERSION).toBe(1);
  });
});

describe('findRequestById', () => {
  it('finds requests nested in folders', () => {
    const found = findRequestById(collections, 'req_saved');
    expect(found).not.toBeNull();
    expect(found.collection.id).toBe('col_1');
    expect(found.request).toMatchObject({
      id: 'req_saved',
      url: 'https://saved.example/fresh',
    });
  });

  it('supports the legacy flat requests shape', () => {
    const legacy = [{ id: 'col_legacy', requests: [{ id: 'req_legacy', url: 'x' }] }];
    expect(findRequestById(legacy, 'req_legacy')).toMatchObject({
      collection: legacy[0],
      request: { id: 'req_legacy' },
    });
  });

  it('returns null for unknown ids and folder ids', () => {
    expect(findRequestById(collections, 'req_missing')).toBeNull();
    expect(findRequestById(collections, 'folder_1')).toBeNull();
    expect(findRequestById(collections, '')).toBeNull();
    expect(findRequestById(null, 'req_saved')).toBeNull();
  });
});
