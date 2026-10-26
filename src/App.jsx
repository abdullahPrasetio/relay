import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import RequestPanel from './components/RequestPanel.jsx';
import ResponsePanel from './components/ResponsePanel.jsx';
import WebSocketPanel from './components/WebSocketPanel.jsx';
import TabBar from './components/TabBar.jsx';
import SplitPane from './components/SplitPane.jsx';
import SaveRequestModal from './components/SaveRequestModal.jsx';
import VariablesModal from './components/VariablesModal.jsx';
import EnvironmentModal from './components/EnvironmentModal.jsx';
import CollectionEditorModal from './components/CollectionEditorModal.jsx';
import CodeModal from './components/CodeModal.jsx';
import RunnerModal from './components/RunnerModal.jsx';
import ActivityRail from './components/ActivityRail.jsx';
import AppHeader from './components/AppHeader.jsx';
import SetVariableModal from './components/SetVariableModal.jsx';
import CookiesModal from './components/CookiesModal.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import RequestSettingsModal from './components/RequestSettingsModal.jsx';
import { VarContext } from './components/VarContext.jsx';
import { useDialogs } from './components/Dialogs.jsx';
import { useStore } from './lib/useStore.js';
import { useNetworkSettings } from './lib/useNetworkSettings.js';
import { newRequest, normalizeRequest, uid } from './lib/factory.js';
import { isWebSocket } from './lib/protocol.js';
import { buildScopeVars, resolveRequest, varsToMap, maskSecrets } from './lib/variables.js';
import { collectSecretValues } from './lib/secretVars.js';
import { runTests, runPreRequest } from './lib/testRunner.js';
import {
  withEffectiveAuth,
  combinedPreRequest,
  combinedTests,
  applyRequestPatch,
} from './lib/inheritance.js';
import {
  addRequest,
  updateRequestNode,
  findRequestCollection,
  findNodePath,
  flattenRequests,
  findFolder,
} from './lib/collectionTree.js';
import {
  SESSION_KEY,
  serializeSession,
  restoreSession,
} from './lib/session.js';

const hasBridge = typeof window !== 'undefined' && !!window.api;

// Request ids correlate a send with http:abort. randomUUID needs a secure
// context (true for file:// and localhost); fall back defensively.
function newRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function maskLogEntry(entry, secrets) {
  if (!entry || typeof entry.text !== 'string') return entry;
  return { ...entry, text: maskSecrets(entry.text, secrets) };
}

// Mask secret values in the "sent" diagnostic view without dropping rows.
function maskSentView(sent, secrets) {
  if (!sent || typeof sent !== 'object') return sent;
  return {
    ...sent,
    url: maskSecrets(sent.url, secrets),
    headers: Array.isArray(sent.headers)
      ? sent.headers.map((header) =>
          header && typeof header === 'object'
            ? { ...header, value: maskSecrets(String(header.value ?? ''), secrets) }
            : header
        )
      : sent.headers,
    body: maskSecrets(sent.body, secrets),
  };
}

const WS_LOG_LIMIT = 500;

// The renderer keeps its own copy of the conversation (outgoing frames are
// only known here; incoming ones arrive through ws:event). Keep it capped at
// the same limit as the main-process history.
function appendWsLog(log, entry) {
  const next = Array.isArray(log) ? [...log, entry] : [entry];
  return next.length > WS_LOG_LIMIT ? next.slice(-WS_LOG_LIMIT) : next;
}

function wsFrameSize({ text, base64 }) {
  if (typeof base64 === 'string') {
    const clean = base64.replace(/\s+/g, '');
    const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
  }
  return new TextEncoder().encode(String(text ?? '')).length;
}

function wsProtocolsFor(request) {
  if (Array.isArray(request?.protocols)) {
    return request.protocols.map((p) => String(p).trim()).filter(Boolean);
  }
  if (typeof request?.protocols === 'string') {
    return request.protocols.split(',').map((p) => p.trim()).filter(Boolean);
  }
  return [];
}

// Mirror the HTTP engine's param handling for socket URLs, then hand the
// main process a single canonical URL.
function buildWebSocketUrl(resolved) {
  const url = new URL(String(resolved.url || '').trim());
  for (const param of resolved.params || []) {
    if (param.enabled !== false && param.key) {
      url.searchParams.append(param.key, param.value ?? '');
    }
  }
  return url.toString();
}

function newTab(request) {
  const req = request ? normalizeRequest(request) : newRequest();
  return {
    tabId: uid('tab'),
    request: req,
    response: null,
    testResults: null,
    sending: false,
    sendingId: null,
    wsSessionId: null,
    wsStatus: null,
    wsLog: [],
    wsError: null,
    dirty: false,
    savedCollectionId: null,
  };
}

// Persisted tab sessions live in localStorage (renderer-only UI state).
function readStoredSession() {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

// True while a tab is still the untouched blank the app boots with. Used to
// avoid restoring a session over edits made before collections finished loading.
function isPristineTab(tab) {
  return (
    !!tab &&
    !tab.dirty &&
    !tab.sending &&
    !tab.response &&
    !!tab.request &&
    tab.request.url === '' &&
    (tab.request.name || 'Untitled Request') === 'Untitled Request'
  );
}

export default function App() {
  const store = useStore();
  const network = useNetworkSettings();
  const dialogs = useDialogs();
  const [tabs, setTabs] = useState(() => [newTab()]);
  const [activeTabId, setActiveTabId] = useState(() => tabs[0].tabId);
  const [saveModal, setSaveModal] = useState(null); // {request}
  const [varsModalCollectionId, setVarsModalCollectionId] = useState(null);
  const [collectionEditorId, setCollectionEditorId] = useState(null);
  const [envModalId, setEnvModalId] = useState(null);
  const [codeModal, setCodeModal] = useState(null); // {request}
  const [runner, setRunner] = useState(null); // {title, requests, collection}
  const [railView, setRailView] = useState('collections');
  const [globalSearch, setGlobalSearch] = useState('');
  const [setVarModal, setSetVarModal] = useState(null); // { value }
  const [cookiesOpen, setCookiesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [requestSettingsOpen, setRequestSettingsOpen] = useState(false);

  // Session restore waits for the store: tab requests that live in a
  // collection must be rebuilt from the freshly loaded tree.
  const [rawSession] = useState(readStoredSession);
  const [sessionReady, setSessionReady] = useState(false);
  const restoreStarted = useRef(false);

  const activeTab = tabs.find((t) => t.tabId === activeTabId) || tabs[0];

  const activeEnv = useMemo(
    () => store.environments.find((e) => e.id === store.activeEnvId) || null,
    [store.environments, store.activeEnvId]
  );

  // Variable lookup for {{token}} tooltips, scoped to the active request's
  // collection. Precedence (highest first): environment > collection > globals.
  const varLookup = useMemo(() => {
    const owning = findRequestCollection(store.collections, activeTab?.request?.id);
    const scoped = [
      ['environment', activeEnv?.variables],
      ['collection', owning?.variables],
      ['globals', store.globals],
    ];
    return (name) => {
      for (const [scope, list] of scoped) {
        const hit = (list || []).find((v) => v.enabled !== false && v.key === name);
        if (hit) return { value: hit.value ?? '', scope };
      }
      return null;
    };
  }, [store.collections, store.globals, activeEnv, activeTab?.request?.id]);

  const updateTab = useCallback((tabId, patch) => {
    setTabs((prev) => prev.map((t) => (t.tabId === tabId ? { ...t, ...patch } : t)));
  }, []);

  const setActiveRequest = useCallback(
    (request) => {
      updateTab(activeTabId, { request, dirty: true });
      // Live-sync: if this request already lives in a collection, reflect the
      // edit in the tree immediately so the sidebar never shows stale data.
      const owning = findRequestCollection(store.collections, request.id);
      if (owning) {
        store.setCollections(updateRequestNode(store.collections, owning.id, request));
      }
    },
    [activeTabId, updateTab, store]
  );

  // Persist mutated variable objects back into the store (env + collection + globals).
  const persistVarMutations = useCallback(
    (envObj, colObj, globObj, owningCollection) => {
      // Functional updates: `store.*` from this closure predates any state the
      // run itself changed (e.g. trusting a collection), and mapping over the
      // stale array would silently revert those changes.
      if (activeEnv) {
        store.setEnvironments((prev) =>
          prev.map((e) =>
            e.id === activeEnv.id ? { ...e, variables: objToVarList(envObj, e.variables) } : e
          )
        );
      } else {
        // No active environment: don't silently drop pm.environment.set /
        // pm.variables.set writes. Fold them into globals so they persist and
        // are visible in the Globals panel.
        for (const [k, v] of Object.entries(envObj)) globObj[k] = v;
      }
      if (owningCollection) {
        store.setCollections((prev) =>
          prev.map((c) =>
            c.id === owningCollection.id
              ? { ...c, variables: objToVarList(colObj, c.variables) }
              : c
          )
        );
      }
      store.setGlobals((prev) => objToVarList(globObj, prev));
    },
    [activeEnv, store]
  );

  // Shared transport (Electron bridge or browser fallback). The request id is
  // forwarded so the main process can abort this exact request; the browser
  // fallback cannot be aborted and ignores it.
  const transport = useCallback(
    (resolvedRequest, requestId) =>
      hasBridge
        ? window.api.sendRequest(resolvedRequest, requestId)
        : browserFallbackSend(resolvedRequest),
    []
  );

  // Open a socket for a ws/wss request. `sending` stays true while the socket
  // is open so RequestPanel's Send button becomes Stop; a close event (local
  // or remote) clears it.
  const openWebSocket = useCallback(
    async (tab) => {
      if (!hasBridge || typeof window.api.wsConnect !== 'function') {
        updateTab(tab.tabId, {
          sending: false,
          sendingId: null,
          wsStatus: { state: 'closed', at: Date.now() },
          wsError: 'WebSocket transport is only available in the desktop app.',
        });
        return;
      }

      const sessionId = newRequestId();
      updateTab(tab.tabId, {
        sending: true,
        sendingId: sessionId,
        wsSessionId: sessionId,
        wsStatus: { state: 'connecting', at: Date.now() },
        wsLog: [],
        wsError: null,
        response: null,
        testResults: null,
      });

      try {
        const owningCollection = findRequestCollection(store.collections, tab.request.id);
        const chain = findNodePath(store.collections, tab.request.id) || [];
        const vars = buildScopeVars({
          collection: varsToMap(owningCollection?.variables),
          environment: varsToMap(activeEnv),
          globals: varsToMap(store.globals),
        });
        const resolved = resolveRequest(withEffectiveAuth(tab.request, chain), vars);

        const headers = {};
        for (const header of resolved.headers || []) {
          if (header.enabled === false || !header.key) continue;
          headers[header.key] = header.value ?? '';
        }

        const result = await window.api.wsConnect({
          id: sessionId,
          url: buildWebSocketUrl(resolved),
          headers,
          protocols: wsProtocolsFor(tab.request),
        });

        if (!result?.ok) {
          updateTab(tab.tabId, {
            sending: false,
            sendingId: null,
            wsSessionId: null,
            wsStatus: { state: 'closed', at: Date.now() },
            wsError: result?.error || 'WebSocket connection failed',
          });
        }
      } catch (err) {
        updateTab(tab.tabId, {
          sending: false,
          sendingId: null,
          wsSessionId: null,
          wsStatus: { state: 'closed', at: Date.now() },
          wsError: err?.message || String(err),
        });
      }
    },
    [activeEnv, store, updateTab]
  );

  // Close a session without waiting for the close event. Used for tab
  // switches/closes, where the tab stops being visible and its state no
  // longer matters.
  const disconnectTabWs = useCallback((tabId, sessionId, reason = '') => {
    if (!sessionId) return;
    if (hasBridge && typeof window.api.wsClose === 'function') {
      try {
        const pending = window.api.wsClose({ id: sessionId });
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      } catch {
        /* socket already gone */
      }
    }
    setTabs((prev) =>
      prev.map((tab) =>
        tab.tabId === tabId && tab.wsSessionId === sessionId
          ? {
              ...tab,
              wsSessionId: null,
              sending: false,
              sendingId: null,
              wsStatus: { state: 'closed', reason, at: Date.now() },
            }
          : tab
      )
    );
  }, []);

  const sendWsFrame = useCallback(
    async (payload) => {
      const tab = tabs.find((t) => t.tabId === activeTabId);
      if (!tab?.wsSessionId || !hasBridge) return false;
      try {
        const result = await window.api.wsSend({ id: tab.wsSessionId, ...payload });
        if (!result?.ok) {
          updateTab(tab.tabId, { wsError: result?.error || 'WebSocket send failed' });
          return false;
        }
        const entry = {
          direction: 'out',
          type: payload.text !== undefined ? 'text' : 'binary',
          ...(payload.text !== undefined
            ? { data: payload.text }
            : { base64: payload.base64 || '' }),
          size: wsFrameSize(payload),
          at: Date.now(),
        };
        setTabs((prev) =>
          prev.map((t) =>
            t.tabId === tab.tabId
              ? { ...t, wsError: null, wsLog: appendWsLog(t.wsLog, entry) }
              : t
          )
        );
        return true;
      } catch (err) {
        updateTab(tab.tabId, { wsError: err?.message || String(err) });
        return false;
      }
    },
    [tabs, activeTabId, updateTab]
  );

  const closeWsConnection = useCallback(async () => {
    const tab = tabs.find((t) => t.tabId === activeTabId);
    if (!tab?.wsSessionId) return;
    const sessionId = tab.wsSessionId;
    updateTab(tab.tabId, {
      wsSessionId: null,
      sending: false,
      sendingId: null,
      wsStatus: { state: 'closed', reason: 'Closed by user', at: Date.now() },
    });
    if (!hasBridge || typeof window.api.wsClose !== 'function') return;
    try {
      await window.api.wsClose({ id: sessionId });
    } catch {
      /* closing an already-closed socket is a no-op in main */
    }
  }, [tabs, activeTabId, updateTab]);

  // Cancel whatever this tab is currently sending. A socket is closed; an
  // HTTP request is aborted by its request id.
  const abort = useCallback(async () => {
    const tab = tabs.find((t) => t.tabId === activeTabId);
    if (!tab) return;
    if (tab.wsSessionId) {
      await closeWsConnection();
      return;
    }
    if (!tab.sendingId || !hasBridge) return;
    try {
      await window.api.abortRequest(tab.sendingId);
    } catch {
      /* a request that already finished cannot be aborted */
    }
  }, [tabs, activeTabId, closeWsConnection]);

  // One subscription fans socket events out by session id, so each session
  // has exactly one listener regardless of how many tabs are open.
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.api : null;
    if (!api || typeof api.onWsEvent !== 'function') return undefined;

    let disposed = false;
    const unsubscribe = api.onWsEvent((payload) => {
      if (disposed) return;
      const { id, event } = payload || {};
      if (!id || !event) return;
      setTabs((prev) =>
        prev.map((tab) => {
          if (tab.wsSessionId !== id) return tab;
          if (event.type === 'open') {
            return { ...tab, wsStatus: { state: 'open', at: event.at } };
          }
          if (event.type === 'text' || event.type === 'binary') {
            return {
              ...tab,
              wsLog: appendWsLog(tab.wsLog, { direction: 'in', ...event }),
            };
          }
          if (event.type === 'close') {
            return {
              ...tab,
              wsSessionId: null,
              sending: false,
              sendingId: null,
              wsStatus: {
                state: 'closed',
                code: event.code,
                reason: event.reason,
                at: event.at,
              },
            };
          }
          if (event.type === 'error') {
            return { ...tab, wsError: event.message };
          }
          return tab;
        })
      );
    });

    return () => {
      disposed = true;
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, []);

  // Switching tabs disconnects the socket that tab owned: the conversation is
  // no longer on screen, and keeping it open would leak a session.
  const previousActiveTabRef = useRef(activeTabId);
  useEffect(() => {
    const previous = previousActiveTabRef.current;
    previousActiveTabRef.current = activeTabId;
    if (previous === activeTabId) return;
    const tab = tabs.find((t) => t.tabId === previous);
    if (tab?.wsSessionId) disconnectTabWs(previous, tab.wsSessionId, 'Tab switched');
  }, [activeTabId, tabs, disconnectTabWs]);

  // Editing a connected request's URL into an HTTP one ends the socket too.
  useEffect(() => {
    if (!activeTab?.wsSessionId) return;
    if (isWebSocket(activeTab.request.url)) return;
    disconnectTabWs(activeTab.tabId, activeTab.wsSessionId, 'URL changed');
  }, [activeTab?.tabId, activeTab?.request.url, activeTab?.wsSessionId, disconnectTabWs]);

  const send = useCallback(async () => {
    const tab = tabs.find((t) => t.tabId === activeTabId);
    if (!tab || !tab.request.url.trim() || tab.sending) return;

    // WebSocket requests share the Send button but not the HTTP pipeline.
    if (isWebSocket(tab.request.url)) {
      await openWebSocket(tab);
      return;
    }

    const requestId = newRequestId();
    updateTab(activeTabId, {
      sending: true,
      sendingId: requestId,
      response: null,
      testResults: null,
    });

    try {
      const owningCollection = findRequestCollection(store.collections, tab.request.id);
      const chain = findNodePath(store.collections, tab.request.id) || [];

      // React state is the plaintext source of truth (see useStore); disk is
      // the only place ciphertext lives. Collect known secret values for
      // masking before scripts can emit them.
      const secretPlaintexts = collectSecretValues(
        activeEnv?.variables,
        owningCollection?.variables,
        store.globals
      );

      // Mutable scope objects for scripts to read/write. `local` is per
      // execution only; single sends have no runner data row.
      const scriptContext = {
        local: {},
        iterationData: {},
        environment: varsToMap(activeEnv),
        collection: varsToMap(owningCollection?.variables),
        globals: varsToMap(store.globals),
      };

      // Ancestors' scripts run outside-in, then the request's own script.
      const preScript = combinedPreRequest(tab.request, chain);
      const testScript = combinedTests(tab.request, chain);

      // Trust gate: imported collections are untrusted until the user allows
      // their scripts to run. Ask once, then remember the choice.
      let trusted = owningCollection ? owningCollection.scriptsTrusted !== false : true;
      let scriptsSkipped = false;
      if (!trusted && (preScript || testScript)) {
        const allow = await dialogs.confirm(
          `Run scripts from “${owningCollection.name}”? Scripts can read and change variables and send requests.`,
          { title: 'Trust scripts', okLabel: 'Run scripts' }
        );
        if (allow) {
          trusted = true;
          store.setCollections(
            store.collections.map((c) =>
              c.id === owningCollection.id ? { ...c, scriptsTrusted: true } : c
            )
          );
        } else {
          scriptsSkipped = true;
        }
      }

      // 1. Pre-request script: collection, folders, then the request's.
      //    Scripts get pm.request and may mutate its body/headers/url/method.
      const pre = scriptsSkipped
        ? { ran: false, logs: [] }
        : await runPreRequest(preScript, scriptContext, tab.request, { trusted });
      if (pre.error) {
        updateTab(activeTabId, {
          response: { ok: false, error: `Pre-request script error: ${pre.error}`, timeMs: 0 },
          testResults: null,
        });
        return;
      }

      // Apply any pm.request.* mutations the pre-request script made.
      const effectiveRequest = applyRequestPatch(tab.request, pre.requestPatch);

      // 2. Resolve inherited auth, then variables.
      //    Scopes: local > iteration data > environment > collection > globals.
      const vars = buildScopeVars(scriptContext);
      const withAuth = withEffectiveAuth(effectiveRequest, chain);
      // Unknown tokens are left verbatim (Postman behaviour) but surfaced in
      // the Console tab so a typo does not silently send "{{tokn}}".
      const unresolved = new Set();
      const resolved = resolveRequest(withAuth, vars, {
        onUnresolved: (name, meta) =>
          unresolved.add(meta?.dynamic ? `{{$${name}}}` : `{{${name}}}`),
      });

      // 3. Send. A rejected IPC call (bridge failure) becomes an error response
      //    so the panel can render it like any other failure.
      let result;
      try {
        result = await transport(resolved, requestId);
      } catch (err) {
        result = { ok: false, error: err?.message || String(err), timeMs: 0 };
      }

      // 4. Test script: collection tests run first, then the request's.
      //    Aborted/timed-out requests must not record a test failure.
      const cancelled =
        result &&
        !result.ok &&
        (result.code === 'ABORT_ERR' || result.code === 'ETIMEDOUT');
      const testResults = cancelled || scriptsSkipped
        ? { ran: false, results: [], logs: [] }
        : await runTests(testScript, result, scriptContext, resolved, { trusted });

      // 5. Persist any variable mutations from pre-request + tests. Local is
      //    intentionally not persisted.
      persistVarMutations(
        scriptContext.environment,
        scriptContext.collection,
        scriptContext.globals,
        owningCollection
      );

      // Console output from both script phases, with known secret values masked.
      const consoleLogs = [
        ...(scriptsSkipped
          ? [{ level: 'log', text: 'Scripts skipped: collection not trusted' }]
          : []),
        ...(pre.logs || []),
        ...(testResults.logs || []),
        ...[...unresolved].map((token) => ({
          level: 'warn',
          text: `Unresolved variable ${token}`,
        })),
      ].map((entry) => maskLogEntry(entry, secretPlaintexts));
      const maskedTestResults =
        testResults && Array.isArray(testResults.logs)
          ? {
              ...testResults,
              logs: testResults.logs.map((entry) => maskLogEntry(entry, secretPlaintexts)),
            }
          : testResults;
      const maskedSent = maskSentView(result?.sent, secretPlaintexts);
      const responseWithDiag =
        result && typeof result === 'object'
          ? { ...result, sent: maskedSent, consoleLogs }
          : result;

      updateTab(activeTabId, { response: responseWithDiag, testResults: maskedTestResults });

      store.addHistory({
        id: `h_${Date.now()}`,
        at: new Date().toISOString(),
        method: resolved.method,
        url: result.ok && result.sent ? maskedSent.url : resolved.url,
        status: result.ok ? result.status : null,
        ok: result.ok,
        snapshot: tab.request,
        sent: result.ok ? maskedSent : null,
      });
    } finally {
      updateTab(activeTabId, { sending: false, sendingId: null });
    }
  }, [tabs, activeTabId, activeEnv, store, updateTab, persistVarMutations, transport, dialogs, openWebSocket]);

  const showCode = useCallback(() => {
    const tab = tabs.find((t) => t.tabId === activeTabId);
    if (!tab) return;
    const owningCollection = findRequestCollection(store.collections, tab.request.id);
    const chain = findNodePath(store.collections, tab.request.id) || [];
    const vars = buildScopeVars({
      collection: varsToMap(owningCollection?.variables),
      environment: varsToMap(activeEnv),
      globals: varsToMap(store.globals),
    });
    const resolved = resolveRequest(withEffectiveAuth(tab.request, chain), vars);
    setCodeModal({ request: resolved });
  }, [tabs, activeTabId, activeEnv, store]);

  const openRunner = useCallback(
    (collectionId, folderId) => {
      const collection = store.collections.find((c) => c.id === collectionId);
      if (!collection) return;
      const container = folderId ? findFolder(collection, folderId) : collection;
      if (!container) return;
      const requests = flattenRequests(container);
      setRunner({
        title: folderId ? container.name : collection.name,
        requests,
        collection,
        // [collection, ...folders] so folder scripts/auth apply during a run.
        chain: folderId
          ? findNodePath(store.collections, folderId) || [collection]
          : [collection],
      });
    },
    [store.collections]
  );

  // Persist variable mutations produced by a completed run.
  const persistRunScopes = useCallback(
    (scopes, collection) => {
      if (activeEnv) {
        store.setEnvironments((prev) =>
          prev.map((e) =>
            e.id === activeEnv.id ? { ...e, variables: objToVarList(scopes.environment, e.variables) } : e
          )
        );
      } else {
        // No active environment: fold env-scope writes into globals so they persist.
        for (const [k, v] of Object.entries(scopes.environment || {})) scopes.globals[k] = v;
      }
      if (collection) {
        store.setCollections((prev) =>
          prev.map((c) =>
            c.id === collection.id ? { ...c, variables: objToVarList(scopes.collection, c.variables) } : c
          )
        );
      }
      if (scopes.globals) store.setGlobals((prev) => objToVarList(scopes.globals, prev));
    },
    [activeEnv, store]
  );

  // Save the current response as a named example on the active request.
  const saveExample = useCallback(
    async (response) => {
      if (!response || !response.ok) return;
      const tab = tabs.find((t) => t.tabId === activeTabId);
      if (!tab) return;
      const name = await dialogs.prompt('Example name', 'New Example', {
        title: 'Save Example',
        okLabel: 'Save',
      });
      if (name == null) return;
      const example = {
        id: uid('ex'),
        name: name || 'Example',
        savedAt: new Date().toISOString(),
        request: {
          method: tab.request.method,
          url: tab.request.url,
          headers: tab.request.headers,
          body: tab.request.body,
        },
        response: {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          body: response.body,
          contentType: response.contentType,
        },
      };
      const nextReq = { ...tab.request, examples: [...(tab.request.examples || []), example] };
      updateTab(activeTabId, { request: nextReq });
      const owning = findRequestCollection(store.collections, nextReq.id);
      if (owning) store.setCollections(updateRequestNode(store.collections, owning.id, nextReq));
    },
    [tabs, activeTabId, store, updateTab, dialogs]
  );

  // Open the "Set as variable" dialog for a selected string.
  const openSetVariable = useCallback((value) => {
    const v = (value || '').trim();
    if (!v) return;
    setSetVarModal({ value: v });
  }, []);

  // Persist a new variable into the chosen scope.
  const doSetVariable = useCallback(
    ({ key, value, scope }) => {
      if (scope === 'environment' && activeEnv) {
        store.setEnvironments(
          store.environments.map((e) =>
            e.id === activeEnv.id
              ? { ...e, variables: upsertVar(e.variables, key, value) }
              : e
          )
        );
      } else if (scope === 'collection') {
        const tab = tabs.find((t) => t.tabId === activeTabId);
        const owning = tab && findRequestCollection(store.collections, tab.request.id);
        if (owning) {
          store.setCollections(
            store.collections.map((c) =>
              c.id === owning.id
                ? { ...c, variables: upsertVar(c.variables, key, value) }
                : c
            )
          );
        } else {
          store.setGlobals(upsertVar(store.globals, key, value));
        }
      } else {
        store.setGlobals(upsertVar(store.globals, key, value));
      }
      setSetVarModal(null);
    },
    [activeEnv, store, tabs, activeTabId]
  );

  // Save: if the request already lives in a collection, update in place.
  // Otherwise open the Save dialog to pick a destination.
  const save = useCallback(() => {
    const tab = tabs.find((t) => t.tabId === activeTabId);
    if (!tab) return;
    const owning = findRequestCollection(store.collections, tab.request.id);
    if (owning) {
      store.setCollections(updateRequestNode(store.collections, owning.id, tab.request));
      updateTab(activeTabId, { dirty: false });
    } else {
      setSaveModal({ request: tab.request });
    }
  }, [tabs, activeTabId, store, updateTab]);

  const doSaveToDestination = useCallback(
    ({ name, collectionId, folderId }) => {
      const tab = tabs.find((t) => t.tabId === activeTabId);
      if (!tab) return;
      const req = { ...tab.request, name };
      const { collections: next, node } = addRequest(store.collections, collectionId, folderId, req);
      store.setCollections(next);
      // Rebind the tab to the saved node (so later saves update in place).
      updateTab(activeTabId, { request: node, dirty: false });
      setSaveModal(null);
    },
    [tabs, activeTabId, store, updateTab]
  );
  const openRequest = useCallback(
    (req) => {
      const existing = tabs.find((t) => t.request.id === req.id);
      if (existing) {
        setActiveTabId(existing.tabId);
        return;
      }
      const tab = newTab(req);
      setTabs((prev) => [...prev, tab]);
      setActiveTabId(tab.tabId);
    },
    [tabs]
  );

  const addTab = useCallback(() => {
    const tab = newTab();
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.tabId);
  }, []);

  const closeTab = useCallback(
    (tabId) => {
      const closing = tabs.find((t) => t.tabId === tabId);
      if (closing?.wsSessionId) {
        disconnectTabWs(tabId, closing.wsSessionId, 'Tab closed');
      }
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.tabId === tabId);
        const next = prev.filter((t) => t.tabId !== tabId);
        if (next.length === 0) {
          const fresh = newTab();
          setActiveTabId(fresh.tabId);
          return [fresh];
        }
        if (tabId === activeTabId) {
          const neighbor = next[Math.max(0, idx - 1)];
          setActiveTabId(neighbor.tabId);
        }
        return next;
      });
    },
    [activeTabId, tabs, disconnectTabWs]
  );

  // Restore the persisted session once the collection tree has loaded. It only
  // applies while the untouched initial tab is still the only tab: anything the
  // user typed before the async load finished must never be overwritten.
  useEffect(() => {
    if (!store.loaded || restoreStarted.current) return;
    restoreStarted.current = true;

    const untouched = tabs.length === 1 && isPristineTab(tabs[0]);
    if (rawSession && untouched) {
      const restored = restoreSession(rawSession, {
        collections: store.collections,
        makeTab: (request) => newTab(request),
      });
      if (restored) {
        setTabs(restored.tabs);
        setActiveTabId(restored.activeTabId);
        setRailView(restored.railView);
      }
    }
    // Mark the session authoritative so persistence can start.
    setSessionReady(true);
  }, [store.loaded, store.collections, rawSession, tabs]);

  // Persist the tab layout (debounced). The serialized shape excludes
  // responses/test results, so they never reach storage.
  useEffect(() => {
    if (!sessionReady) return undefined;
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(
          SESSION_KEY,
          JSON.stringify(serializeSession({ tabs, activeTabId, railView }))
        );
      } catch {
        /* storage disabled or over quota: sessions are best-effort */
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [sessionReady, tabs, activeTabId, railView]);

  const hasDirtyTabs = tabs.some((t) => t.dirty);
  const closePromptOpen = useRef(false);

  // Electron asks before closing (main process intercepts window close). A
  // dirty tab gets an in-app confirmation; window.confirm does not work here.
  // The subscription includes `tabs` so the prompt sees current dirty state.
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.api : null;
    if (!api || typeof api.onCloseRequested !== 'function') return undefined;

    const unsubscribe = api.onCloseRequested(async () => {
      // A second close request must not stack dialogs.
      if (closePromptOpen.current) return;
      const dirtyCount = tabs.filter((t) => t.dirty).length;
      if (dirtyCount === 0) {
        try {
          await api.confirmClose?.();
        } catch {
          /* leave the window open; the next close request retries */
        }
        return;
      }

      closePromptOpen.current = true;
      try {
        const discard = await dialogs.confirm(
          `${dirtyCount} tab punya perubahan yang belum disimpan. Keluar tanpa menyimpan?`,
          { title: 'Unsaved changes', okLabel: 'Discard and quit', danger: true }
        );
        if (discard) await api.confirmClose?.();
      } catch {
        /* prompt or IPC failed: keep the window open */
      } finally {
        closePromptOpen.current = false;
      }
    });

    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [tabs, dialogs]);

  // Browser dev has no close handshake; use the native leave prompt there.
  // Electron never registers this (the handshake above is authoritative).
  useEffect(() => {
    if (hasBridge || !hasDirtyTabs) return undefined;
    function onBeforeUnload(e) {
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasDirtyTabs]);

  // Global shortcuts. Capture phase so they run before panel-local handlers;
  // stopPropagation keeps Cmd/Ctrl+Enter from sending twice (RequestPanel has
  // its own bubble-phase handler that does not check defaultPrevented).
  useEffect(() => {
    function onKeyDown(e) {
      if (e.defaultPrevented || e.repeat) return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const key = e.key.toLowerCase();

      if (key === 'enter') {
        const tab = tabs.find((t) => t.tabId === activeTabId);
        if (!tab || tab.sending) return;
        e.preventDefault();
        e.stopPropagation();
        send();
      } else if (key === 's') {
        e.preventDefault();
        save();
      } else if (key === 'w') {
        e.preventDefault();
        closeTab(activeTabId);
      } else if (key === 'k') {
        e.preventDefault();
        const search = document.querySelector('.global-search');
        if (search) {
          search.focus();
          search.select?.();
        }
      }
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [tabs, activeTabId, send, save, closeTab]);

  const varsModalCollection = store.collections.find((c) => c.id === varsModalCollectionId);

  const varsModalEnvironment = store.environments.find((e) => e.id === envModalId);
  const editorCollection = store.collections.find((c) => c.id === collectionEditorId);

  return (
    <VarContext.Provider value={{ lookup: varLookup, onSetVariable: openSetVariable }}>
    <div className="app">
      <AppHeader
        store={store}
        searchQuery={globalSearch}
        onSearch={setGlobalSearch}
        onOpenCookies={() => setCookiesOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {store.saveError && (
        <div className="persist-warning" role="alert" title="Persistence failed">
          Changes not saved: {store.saveError}
        </div>
      )}

      <div className="body">
        <ActivityRail active={railView} onSelect={setRailView} />
        <Sidebar
          view={railView}
          query={globalSearch}
          onQueryChange={setGlobalSearch}
          collections={store.collections}
          onChangeCollections={store.setCollections}
          environments={store.environments}
          onChangeEnvironments={store.setEnvironments}
          activeEnvId={store.activeEnvId}
          onSelectEnv={store.setActiveEnvId}
          history={store.history}
          onClearHistory={() => store.setHistory([])}
          historyLimit={store.historyLimit}
          onChangeHistoryLimit={store.setHistoryLimit}
          onRemoveHistory={store.removeHistoryEntry}
          activeRequestId={activeTab.request.id}
          onOpenRequest={openRequest}
          onEditCollectionVars={setVarsModalCollectionId}
          onOpenCollection={setCollectionEditorId}
          onEditEnvironment={setEnvModalId}
          onRun={openRunner}
        />

        <main className="workspace">
          <TabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onSelect={setActiveTabId}
            onClose={closeTab}
            onAdd={addTab}
          />
          <SplitPane storageKey="req-res-split">
            <RequestPanel
              key={activeTab.tabId}
              request={activeTab.request}
              onChange={setActiveRequest}
              onSend={send}
              onSave={save}
              onShowCode={showCode}
              onSetVariable={openSetVariable}
              onOpenSettings={() => setRequestSettingsOpen(true)}
              onAbort={abort}
              sending={activeTab.sending}
              dirty={activeTab.dirty}
            />
            {isWebSocket(activeTab.request.url) ? (
              <WebSocketPanel
                status={activeTab.wsStatus}
                log={activeTab.wsLog}
                error={activeTab.wsError}
                onSend={sendWsFrame}
                onDisconnect={closeWsConnection}
                onClear={() => updateTab(activeTab.tabId, { wsLog: [] })}
              />
            ) : (
              <ResponsePanel
                response={activeTab.response}
                sending={activeTab.sending}
                testResults={activeTab.testResults}
                onSaveExample={saveExample}
                onSetVariable={openSetVariable}
              />
            )}
          </SplitPane>
        </main>
      </div>

      {saveModal && (
        <SaveRequestModal
          request={saveModal.request}
          collections={store.collections}
          onCancel={() => setSaveModal(null)}
          onSave={doSaveToDestination}
        />
      )}

      {varsModalCollection && (
        <VariablesModal
          collection={varsModalCollection}
          onClose={() => setVarsModalCollectionId(null)}
          onChange={(variables) =>
            store.setCollections(
              store.collections.map((c) =>
                c.id === varsModalCollectionId ? { ...c, variables } : c
              )
            )
          }
        />
      )}

      {editorCollection && (
        <CollectionEditorModal
          collection={editorCollection}
          onClose={() => setCollectionEditorId(null)}
          onChange={(updated) =>
            store.setCollections(
              store.collections.map((c) => (c.id === updated.id ? updated : c))
            )
          }
        />
      )}

      {varsModalEnvironment && (
        <EnvironmentModal
          environment={varsModalEnvironment}
          onClose={() => setEnvModalId(null)}
          onChange={(variables) =>
            store.setEnvironments(
              store.environments.map((e) =>
                e.id === envModalId ? { ...e, variables } : e
              )
            )
          }
        />
      )}

      {setVarModal && (
        <SetVariableModal
          value={setVarModal.value}
          hasEnvironment={!!activeEnv}
          onCancel={() => setSetVarModal(null)}
          onSave={doSetVariable}
        />
      )}

      {cookiesOpen && <CookiesModal onClose={() => setCookiesOpen(false)} />}

      {requestSettingsOpen && (
        <RequestSettingsModal
          request={activeTab.request}
          networkSettings={network.settings}
          onChange={(settings) => setActiveRequest({ ...activeTab.request, settings })}
          onClose={() => setRequestSettingsOpen(false)}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          settings={network.settings}
          onSave={network.save}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {codeModal && <CodeModal request={codeModal.request} onClose={() => setCodeModal(null)} />}

      {runner && (
        <RunnerModal
          title={runner.title}
          requests={runner.requests}
          collection={runner.collection}
          chain={runner.chain}
          environment={activeEnv}
          globals={store.globals}
          send={transport}
          onPersistScopes={(scopes) => persistRunScopes(scopes, runner.collection)}
          onClose={() => setRunner(null)}
        />
      )}
    </div>
    </VarContext.Provider>
  );
}

// Add or update a key in a variable list, preserving order/enabled flags.
function upsertVar(list, key, value) {
  const next = (list || []).map((v) => ({ ...v }));
  const existing = next.find((v) => v.key === key);
  if (existing) existing.value = value;
  else next.push({ key, value, enabled: true });
  return next;
}

function objToVarList(obj, existing) {
  const list = (existing || []).map((v) => ({ ...v }));
  const seen = new Set();
  for (const v of list) {
    if (v.key in obj) {
      v.value = obj[v.key];
      seen.add(v.key);
    }
  }
  for (const [key, value] of Object.entries(obj)) {
    if (!seen.has(key) && !list.some((v) => v.key === key)) {
      list.push({ key, value, enabled: true });
    }
  }
  return list;
}

async function browserFallbackSend(request) {
  const started = Date.now();
  try {
    const url = new URL(
      /^https?:\/\//i.test(request.url) ? request.url : 'https://' + request.url
    );
    for (const p of request.params || []) {
      if (p.enabled !== false && p.key) url.searchParams.append(p.key, p.value);
    }
    const headers = {};
    for (const h of request.headers || []) {
      if (h.enabled !== false && h.key) headers[h.key] = h.value;
    }
    const init = { method: request.method, headers };
    if (request.body && request.body.mode !== 'none' && request.method !== 'GET') {
      init.body = request.body.raw;
      if (request.body.mode === 'json' && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
    }
    const res = await fetch(url.toString(), init);
    const text = await res.text();
    const outHeaders = [];
    res.headers.forEach((value, key) => outHeaders.push({ key, value }));
    return {
      ok: true,
      status: res.status,
      statusText: res.statusText,
      headers: outHeaders,
      cookies: [],
      body: text,
      size: new Blob([text]).size,
      contentType: res.headers.get('content-type') || '',
      timeMs: Date.now() - started,
    };
  } catch (err) {
    return { ok: false, error: err.message, timeMs: Date.now() - started };
  }
}
