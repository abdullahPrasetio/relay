import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import RequestPanel from './components/RequestPanel.jsx';
import ResponsePanel from './components/ResponsePanel.jsx';
import WebSocketPanel from './components/WebSocketPanel.jsx';
import MqttPanel from './components/MqttPanel.jsx';
import SocketIoPanel from './components/SocketIoPanel.jsx';
import GrpcPanel from './components/GrpcPanel.jsx';
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
import MockServerModal from './components/MockServerModal.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import AppearanceModal from './components/AppearanceModal.jsx';
import RequestSettingsModal from './components/RequestSettingsModal.jsx';
import CloudAuthModal from './components/CloudAuthModal.jsx';
import CloudDevicesModal from './components/CloudDevicesModal.jsx';
import ConflictResolveModal from './components/ConflictResolveModal.jsx';
import { VarContext } from './components/VarContext.jsx';
import { useDialogs } from './components/Dialogs.jsx';
import { useStore } from './lib/useStore.js';
import { useCloudSync } from './lib/useCloudSync.js';
import { useRealtimeSync } from './lib/useRealtimeSync.js';
import { useNetworkSettings } from './lib/useNetworkSettings.js';
import { useAppearance } from './lib/useAppearance.js';
import { newRequest, normalizeRequest, uid } from './lib/factory.js';
import { isWebSocket, isMqtt, isSocketIo, isGrpc, isGrpcTls } from './lib/protocol.js';
import { buildScopeVars, resolveRequest, varsToMap, maskSecrets } from '../packages/core/src/variables.js';
import { collectSecretValues } from './lib/secretVars.js';
import { runTests, runPreRequest } from './lib/testRunner.js';
import {
  withEffectiveAuth,
  combinedPreRequest,
  combinedTests,
  applyRequestPatch,
} from '../packages/core/src/inheritance.js';
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

// Size of a Socket.IO payload, used only for the renderer's log preview.
function jsonSize(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return 0;
  }
}

// gRPC arguments shared by unary and streaming calls. The target keeps its
// grpc:///grpcs:// scheme; main strips it and uses `tls` for credentials.
function grpcPayloadFor(request) {
  const grpc = request?.grpc || {};
  return {
    target: request?.url || '',
    protoPath: grpc.protoPath || '',
    service: grpc.service || '',
    method: grpc.method || '',
    message: grpc.message ?? '{}',
    metadata: Array.isArray(grpc.metadata) ? grpc.metadata : [],
    tls: isGrpcTls(request?.url || ''),
  };
}

// gRPC selection is per request; the panel keeps the fields in sync through
// `onChange`, so a tab switch re-reads them from the request itself.
function grpcMissingField(request) {
  const grpc = request?.grpc || {};
  if (!grpc.protoPath) return 'Choose a .proto file';
  if (!grpc.service || !grpc.method) return 'Choose a service and method';
  return null;
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
    streamKind: null,
    streamSessionId: null,
    streamStatus: null,
    streamLog: [],
    streamError: null,
    streamUrl: null,
    grpcStreamId: null,
    grpcLog: [],
    grpcError: null,
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
  const cloud = useCloudSync(store);
  const network = useNetworkSettings();
  const appearance = useAppearance();
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
  const [mockOpen, setMockOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [cloudAuthOpen, setCloudAuthOpen] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [conflictModalOpen, setConflictModalOpen] = useState(false);
  const [requestSettingsOpen, setRequestSettingsOpen] = useState(false);

  // Session restore waits for the store: tab requests that live in a
  // collection must be rebuilt from the freshly loaded tree.
  const [rawSession] = useState(readStoredSession);
  const [sessionReady, setSessionReady] = useState(false);
  const restoreStarted = useRef(false);

  const activeTab = tabs.find((t) => t.tabId === activeTabId) || tabs[0];

  // Live sync for the attached workspace: SSE events trigger a throttled pull,
  // and presence is heartbeated for the request currently open.
  const remoteWorkspaceId = store.activeWorkspace?.cloud?.remoteId || null;
  useRealtimeSync({
    workspaceId: remoteWorkspaceId,
    entityId: remoteWorkspaceId ? activeTab?.request?.id ?? null : null,
    syncNow: () => cloud.syncNow(),
  });

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

  // Open an MQTT or Socket.IO session. Both share one tab lifecycle: `sending`
  // keeps Send as Stop while the session is open and the panel renders from
  // streamStatus / streamLog / streamError.
  const openStream = useCallback(
    async (tab, kind) => {
      const api = typeof window !== 'undefined' ? window.api : null;
      const connectFn = kind === 'mqtt' ? api?.mqttConnect : api?.socketIoConnect;
      if (!hasBridge || typeof connectFn !== 'function') {
        updateTab(tab.tabId, {
          sending: false,
          sendingId: null,
          streamStatus: { state: 'closed', at: Date.now() },
          streamError:
            kind === 'mqtt'
              ? 'MQTT transport is only available in the desktop app.'
              : 'Socket.IO transport is only available in the desktop app.',
        });
        return;
      }

      const sessionId = newRequestId();
      updateTab(tab.tabId, {
        sending: true,
        sendingId: sessionId,
        streamKind: kind,
        streamSessionId: sessionId,
        streamUrl: tab.request.url,
        streamStatus: { state: 'connecting', at: Date.now() },
        streamLog: [],
        streamError: null,
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
        const target = buildWebSocketUrl(resolved);

        const headers = {};
        for (const header of resolved.headers || []) {
          if (header.enabled === false || !header.key) continue;
          headers[header.key] = header.value ?? '';
        }

        const auth = resolved.auth || {};
        let result;
        if (kind === 'mqtt') {
          const username = auth.type === 'basic' ? auth.basic?.username || '' : '';
          const password = auth.type === 'basic' ? auth.basic?.password || '' : '';
          result = await api.mqttConnect({
            id: sessionId,
            url: target,
            username: username || undefined,
            password: password || undefined,
          });
        } else {
          let authPayload;
          if (auth.type === 'bearer' && auth.bearer?.token) {
            authPayload = { token: auth.bearer.token };
          } else if (auth.type === 'basic' && auth.basic?.username) {
            authPayload = {
              username: auth.basic.username,
              password: auth.basic.password || '',
            };
          }
          result = await api.socketIoConnect({
            id: sessionId,
            url: target,
            auth: authPayload,
            headers,
          });
        }

        if (!result?.ok) {
          updateTab(tab.tabId, {
            sending: false,
            sendingId: null,
            streamSessionId: null,
            streamStatus: { state: 'closed', at: Date.now() },
            streamError:
              result?.error ||
              (kind === 'mqtt' ? 'MQTT connection failed' : 'Socket.IO connection failed'),
          });
        }
      } catch (err) {
        updateTab(tab.tabId, {
          sending: false,
          sendingId: null,
          streamSessionId: null,
          streamStatus: { state: 'closed', at: Date.now() },
          streamError: err?.message || String(err),
        });
      }
    },
    [activeEnv, store, updateTab]
  );

  // Close a stream session without waiting for a lifecycle event (tab switch,
  // tab close, URL change). State is cleared locally so a late event is
  // ignored instead of reopening a dead panel.
  const disconnectTabStream = useCallback((tabId, sessionId, kind, reason = '') => {
    if (!sessionId) return;
    const api = typeof window !== 'undefined' ? window.api : null;
    const closeFn = kind === 'mqtt' ? api?.mqttClose : api?.socketIoClose;
    if (typeof closeFn === 'function') {
      try {
        const pending = closeFn({ id: sessionId });
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      } catch {
        /* session already gone */
      }
    }
    setTabs((prev) =>
      prev.map((tab) =>
        tab.tabId === tabId && tab.streamSessionId === sessionId
          ? {
              ...tab,
              streamSessionId: null,
              sending: false,
              sendingId: null,
              streamStatus: { state: 'closed', reason, at: Date.now() },
            }
          : tab
      )
    );
  }, []);

  const sendMqttPublish = useCallback(
    async (payload) => {
      const tab = tabs.find((t) => t.tabId === activeTabId);
      if (!tab?.streamSessionId || tab.streamKind !== 'mqtt' || !hasBridge) return false;
      try {
        const result = await window.api.mqttPublish({ id: tab.streamSessionId, ...payload });
        if (!result?.ok) {
          updateTab(tab.tabId, { streamError: result?.error || 'MQTT publish failed' });
          return false;
        }
        const entry = {
          direction: 'out',
          topic: payload.topic,
          ...(payload.base64 !== undefined
            ? { payload: payload.base64, binary: true }
            : { text: payload.payload ?? '' }),
          size: wsFrameSize({ text: payload.payload, base64: payload.base64 }),
          qos: Number(payload.qos) || 0,
          retain: Boolean(payload.retain),
          at: Date.now(),
        };
        setTabs((prev) =>
          prev.map((t) =>
            t.tabId === tab.tabId
              ? { ...t, streamError: null, streamLog: appendWsLog(t.streamLog, entry) }
              : t
          )
        );
        return true;
      } catch (err) {
        updateTab(tab.tabId, { streamError: err?.message || String(err) });
        return false;
      }
    },
    [tabs, activeTabId, updateTab]
  );

  const sendMqttSubscribe = useCallback(
    async (topic, qos) => {
      const tab = tabs.find((t) => t.tabId === activeTabId);
      if (!tab?.streamSessionId || tab.streamKind !== 'mqtt' || !hasBridge) return false;
      try {
        const result = await window.api.mqttSubscribe({ id: tab.streamSessionId, topic, qos });
        if (!result?.ok) {
          updateTab(tab.tabId, { streamError: result?.error || 'MQTT subscribe failed' });
          return false;
        }
        updateTab(tab.tabId, { streamError: null });
        return true;
      } catch (err) {
        updateTab(tab.tabId, { streamError: err?.message || String(err) });
        return false;
      }
    },
    [tabs, activeTabId, updateTab]
  );

  const sendMqttUnsubscribe = useCallback(
    async (topic) => {
      const tab = tabs.find((t) => t.tabId === activeTabId);
      if (!tab?.streamSessionId || tab.streamKind !== 'mqtt' || !hasBridge) return false;
      try {
        const result = await window.api.mqttUnsubscribe({ id: tab.streamSessionId, topic });
        if (!result?.ok) {
          updateTab(tab.tabId, { streamError: result?.error || 'MQTT unsubscribe failed' });
          return false;
        }
        updateTab(tab.tabId, { streamError: null });
        return true;
      } catch (err) {
        updateTab(tab.tabId, { streamError: err?.message || String(err) });
        return false;
      }
    },
    [tabs, activeTabId, updateTab]
  );

  const sendSocketIoEmit = useCallback(
    async (event, args) => {
      const tab = tabs.find((t) => t.tabId === activeTabId);
      if (!tab?.streamSessionId || tab.streamKind !== 'socketio' || !hasBridge) return false;
      try {
        const result = await window.api.socketIoEmit({
          id: tab.streamSessionId,
          event,
          args,
        });
        if (!result?.ok) {
          updateTab(tab.tabId, { streamError: result?.error || 'Socket.IO emit failed' });
          return false;
        }
        const entry = { direction: 'out', event, args, size: jsonSize(args), at: Date.now() };
        setTabs((prev) =>
          prev.map((t) =>
            t.tabId === tab.tabId
              ? { ...t, streamError: null, streamLog: appendWsLog(t.streamLog, entry) }
              : t
          )
        );
        return true;
      } catch (err) {
        updateTab(tab.tabId, { streamError: err?.message || String(err) });
        return false;
      }
    },
    [tabs, activeTabId, updateTab]
  );

  const closeStreamConnection = useCallback(async () => {
    const tab = tabs.find((t) => t.tabId === activeTabId);
    if (!tab?.streamSessionId) return;
    const sessionId = tab.streamSessionId;
    const kind = tab.streamKind;
    updateTab(tab.tabId, {
      streamSessionId: null,
      sending: false,
      sendingId: null,
      streamStatus: { state: 'closed', reason: 'Closed by user', at: Date.now() },
    });
    const api = typeof window !== 'undefined' ? window.api : null;
    const closeFn = kind === 'mqtt' ? api?.mqttClose : api?.socketIoClose;
    if (typeof closeFn !== 'function') return;
    try {
      await closeFn({ id: sessionId });
    } catch {
      /* closing an already-closed session is a no-op in main */
    }
  }, [tabs, activeTabId, updateTab]);

  // ---- gRPC ----
  // Send is a unary call. The result is mapped into the normal response shape
  // so diagnostics still work; no pre-request/test scripts run for gRPC.
  const sendGrpcUnary = useCallback(
    async (tab) => {
      const api = typeof window !== 'undefined' ? window.api : null;
      const missing = grpcMissingField(tab.request);
      if (missing) {
        updateTab(tab.tabId, {
          response: { ok: false, error: missing, timeMs: 0 },
          testResults: null,
          grpcError: missing,
        });
        return;
      }
      if (!api || typeof api.grpcInvoke !== 'function') {
        updateTab(tab.tabId, {
          response: {
            ok: false,
            error: 'gRPC is only available in the desktop app.',
            timeMs: 0,
          },
          testResults: null,
        });
        return;
      }

      const requestId = newRequestId();
      updateTab(tab.tabId, {
        sending: true,
        sendingId: requestId,
        response: null,
        testResults: null,
        grpcError: null,
      });

      try {
        const result = await api.grpcInvoke(grpcPayloadFor(tab.request));
        if (result?.ok) {
          const body = JSON.stringify(result.response ?? {});
          updateTab(tab.tabId, {
            response: {
              ok: true,
              status: 0,
              statusText: 'gRPC',
              headers: Array.isArray(result.metadata) ? result.metadata : [],
              body,
              contentType: 'application/json',
              timeMs: result.durationMs ?? 0,
              size: body.length,
              sent: {
                method: 'GRPC',
                url: tab.request.url,
                headers: [],
                body: tab.request.grpc?.message ?? '',
              },
            },
            testResults: null,
          });
        } else {
          updateTab(tab.tabId, {
            response: {
              ok: false,
              error: result?.error || 'gRPC call failed',
              timeMs: result?.durationMs ?? 0,
            },
            testResults: null,
          });
        }
      } catch (err) {
        updateTab(tab.tabId, {
          response: { ok: false, error: err?.message || String(err), timeMs: 0 },
          testResults: null,
        });
      } finally {
        updateTab(tab.tabId, { sending: false, sendingId: null });
      }
    },
    [updateTab]
  );

  const startGrpcStream = useCallback(
    async (tab) => {
      const api = typeof window !== 'undefined' ? window.api : null;
      const missing = grpcMissingField(tab.request);
      if (missing) {
        updateTab(tab.tabId, { grpcError: missing });
        return;
      }
      if (!api || typeof api.grpcStreamStart !== 'function') {
        updateTab(tab.tabId, {
          grpcError: 'gRPC streaming is only available in the desktop app.',
        });
        return;
      }

      const sessionId = newRequestId();
      updateTab(tab.tabId, {
        sending: true,
        sendingId: sessionId,
        grpcStreamId: sessionId,
        grpcLog: [],
        grpcError: null,
        response: null,
        testResults: null,
      });

      try {
        const result = await api.grpcStreamStart({
          id: sessionId,
          ...grpcPayloadFor(tab.request),
        });
        if (!result?.ok) {
          updateTab(tab.tabId, {
            sending: false,
            sendingId: null,
            grpcStreamId: null,
            grpcError: result?.error || 'Could not start the stream',
          });
        }
      } catch (err) {
        updateTab(tab.tabId, {
          sending: false,
          sendingId: null,
          grpcStreamId: null,
          grpcError: err?.message || String(err),
        });
      }
    },
    [updateTab]
  );

  // Stop an open stream locally *and* in main. `reason` lands in the log so a
  // cancelled stream never looks like a server-side end.
  const cancelGrpcStream = useCallback((tabId, sessionId, reason = 'Cancelled') => {
    if (!sessionId) return;
    const api = typeof window !== 'undefined' ? window.api : null;
    if (api && typeof api.grpcStreamCancel === 'function') {
      try {
        const pending = api.grpcStreamCancel(sessionId);
        pending?.catch?.(() => {});
      } catch {
        /* already gone in main */
      }
    }
    setTabs((prev) =>
      prev.map((tab) =>
        tab.tabId === tabId && tab.grpcStreamId === sessionId
          ? {
              ...tab,
              grpcStreamId: null,
              sending: false,
              sendingId: null,
              grpcLog: appendWsLog(tab.grpcLog, {
                type: 'end',
                status: { code: 1, details: reason },
                at: Date.now(),
              }),
            }
          : tab
      )
    );
  }, []);

  // Cancel whatever this tab is currently sending. A socket is closed; an
  // HTTP request is aborted by its request id.
  const abort = useCallback(async () => {
    const tab = tabs.find((t) => t.tabId === activeTabId);
    if (!tab) return;
    if (tab.wsSessionId) {
      await closeWsConnection();
      return;
    }
    if (tab.streamSessionId) {
      await closeStreamConnection();
      return;
    }
    if (tab.grpcStreamId) {
      cancelGrpcStream(tab.tabId, tab.grpcStreamId, 'Cancelled');
      return;
    }
    if (!tab.sendingId || !hasBridge) return;
    try {
      await window.api.abortRequest(tab.sendingId);
    } catch {
      /* a request that already finished cannot be aborted */
    }
  }, [tabs, activeTabId, closeWsConnection, closeStreamConnection, cancelGrpcStream]);

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

  // MQTT session events. Same fan-out pattern as WebSocket; the stream fields
  // are separate so the WebSocket path stays untouched.
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.api : null;
    if (!api || typeof api.onMqttEvent !== 'function') return undefined;

    let disposed = false;
    const unsubscribe = api.onMqttEvent((payload) => {
      if (disposed) return;
      const { id, event } = payload || {};
      if (!id || !event) return;
      setTabs((prev) =>
        prev.map((tab) => {
          if (tab.streamSessionId !== id || tab.streamKind !== 'mqtt') return tab;
          if (event.type === 'connect') {
            return {
              ...tab,
              streamStatus: {
                state: 'open',
                clientId: event.clientId,
                at: event.at,
              },
            };
          }
          if (event.type === 'message') {
            return {
              ...tab,
              streamLog: appendWsLog(tab.streamLog, { direction: 'in', ...event }),
            };
          }
          if (event.type === 'error') {
            return { ...tab, streamError: event.message };
          }
          if (event.type === 'close') {
            return {
              ...tab,
              streamSessionId: null,
              sending: false,
              sendingId: null,
              streamStatus: { state: 'closed', reason: event.reason, at: event.at },
            };
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

  // Socket.IO session events.
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.api : null;
    if (!api || typeof api.onSocketIoEvent !== 'function') return undefined;

    let disposed = false;
    const unsubscribe = api.onSocketIoEvent((payload) => {
      if (disposed) return;
      const { id, event } = payload || {};
      if (!id || !event) return;
      setTabs((prev) =>
        prev.map((tab) => {
          if (tab.streamSessionId !== id || tab.streamKind !== 'socketio') return tab;
          if (event.type === 'connect') {
            return {
              ...tab,
              streamStatus: {
                state: 'open',
                socketId: event.socketId,
                transport: event.transport,
                at: event.at,
              },
            };
          }
          if (event.type === 'message') {
            return {
              ...tab,
              streamLog: appendWsLog(tab.streamLog, { direction: 'in', ...event }),
            };
          }
          if (event.type === 'error') {
            return { ...tab, streamError: event.message };
          }
          if (event.type === 'disconnect') {
            return {
              ...tab,
              streamSessionId: null,
              sending: false,
              sendingId: null,
              streamStatus: { state: 'closed', reason: event.reason, at: event.at },
            };
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

  // gRPC stream events, keyed by the renderer-generated stream id. A terminal
  // event clears the id so the Send button returns to its normal state.
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.api : null;
    if (!api || typeof api.onGrpcEvent !== 'function') return undefined;

    let disposed = false;
    const unsubscribe = api.onGrpcEvent((payload) => {
      if (disposed) return;
      const { id, event } = payload || {};
      if (!id || !event) return;
      setTabs((prev) =>
        prev.map((tab) => {
          if (tab.grpcStreamId !== id) return tab;
          if (event.type === 'data' || event.type === 'end' || event.type === 'error') {
            return { ...tab, grpcLog: appendWsLog(tab.grpcLog, event) };
          }
          return tab;
        })
      );
      if (event.type === 'end' || event.type === 'error') {
        setTabs((prev) =>
          prev.map((tab) =>
            tab.grpcStreamId === id
              ? {
                  ...tab,
                  grpcStreamId: null,
                  sending: false,
                  sendingId: null,
                  grpcError: event.type === 'error' ? event.message : tab.grpcError,
                }
              : tab
          )
        );
      }
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
    if (tab?.streamSessionId) {
      disconnectTabStream(previous, tab.streamSessionId, tab.streamKind, 'Tab switched');
    }
    if (tab?.grpcStreamId) {
      cancelGrpcStream(tab.tabId, tab.grpcStreamId, 'Tab switched');
    }
  }, [activeTabId, tabs, disconnectTabWs, disconnectTabStream, cancelGrpcStream]);

  // Editing a connected request's URL into an HTTP one ends the socket too.
  useEffect(() => {
    if (!activeTab?.wsSessionId) return;
    if (isWebSocket(activeTab.request.url)) return;
    disconnectTabWs(activeTab.tabId, activeTab.wsSessionId, 'URL changed');
  }, [activeTab?.tabId, activeTab?.request.url, activeTab?.wsSessionId, disconnectTabWs]);

  // Same rule for MQTT/Socket.IO: editing the connected URL (any edit, not
  // only a scheme change) ends the session so the panel never outlives it.
  useEffect(() => {
    if (!activeTab?.streamSessionId) return;
    if (activeTab.streamUrl === activeTab.request.url) return;
    disconnectTabStream(
      activeTab.tabId,
      activeTab.streamSessionId,
      activeTab.streamKind,
      'URL changed'
    );
  }, [
    activeTab?.tabId,
    activeTab?.request.url,
    activeTab?.streamSessionId,
    activeTab?.streamUrl,
    activeTab?.streamKind,
    disconnectTabStream,
  ]);

  const send = useCallback(async () => {
    const tab = tabs.find((t) => t.tabId === activeTabId);
    if (!tab || !tab.request.url.trim() || tab.sending) return;

    // gRPC uses Send for a unary call; server streaming is started from the
    // panel's Stream button.
    if (isGrpc(tab.request.url)) {
      await sendGrpcUnary(tab);
      return;
    }

    // WebSocket requests share the Send button but not the HTTP pipeline.
    if (isWebSocket(tab.request.url)) {
      await openWebSocket(tab);
      return;
    }

    // MQTT and Socket.IO use the same Send-as-connect lifecycle.
    if (isMqtt(tab.request.url)) {
      await openStream(tab, 'mqtt');
      return;
    }
    if (isSocketIo(tab.request.url)) {
      await openStream(tab, 'socketio');
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
  }, [tabs, activeTabId, activeEnv, store, updateTab, persistVarMutations, transport, dialogs, openWebSocket, openStream, sendGrpcUnary]);

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
      if (closing?.streamSessionId) {
        disconnectTabStream(tabId, closing.streamSessionId, closing.streamKind, 'Tab closed');
      }
      if (closing?.grpcStreamId) {
        cancelGrpcStream(tabId, closing.grpcStreamId, 'Tab closed');
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
    [activeTabId, tabs, disconnectTabWs, disconnectTabStream, cancelGrpcStream]
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
        cloud={cloud}
        searchQuery={globalSearch}
        onSearch={setGlobalSearch}
        onOpenCookies={() => setCookiesOpen(true)}
        onOpenMock={() => setMockOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenAppearance={() => setAppearanceOpen(true)}
        onOpenCloud={() => setCloudAuthOpen(true)}
        onOpenDevices={() => setDevicesOpen(true)}
      />

      {store.saveError && (
        <div className="persist-warning" role="alert" title="Persistence failed">
          Changes not saved: {store.saveError}
        </div>
      )}

      {cloud.conflicts.length > 0 && (
        <div className="cloud-conflict-banner" role="alert" data-testid="cloud-conflict-banner">
          <span className="cloud-conflict-text">
            {cloud.conflicts.length === 1
              ? '1 change conflicts with the cloud copy.'
              : `${cloud.conflicts.length} changes conflict with the cloud copy.`}{' '}
            Local edits were kept; per-field merge is not available yet.
            <span className="cloud-conflict-ids">
              {' '}
              {cloud.conflicts
                .slice(0, 5)
                .map((entry) => entry.id)
                .join(', ')}
              {cloud.conflicts.length > 5 ? ` +${cloud.conflicts.length - 5} more` : ''}
            </span>
          </span>
          <button
            type="button"
            className="mini-btn"
            onClick={() => setConflictModalOpen(true)}
            data-testid="cloud-conflict-review"
          >
            Review
          </button>
          <button type="button" className="mini-btn" onClick={() => cloud.syncNow()}>
            Retry sync
          </button>
          <button
            type="button"
            className="mini-btn"
            onClick={() => cloud.dismissConflicts()}
            title="Keep the local version and clear the conflict"
          >
            Dismiss (keep local)
          </button>
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
            {isGrpc(activeTab.request.url) ? (
              <GrpcPanel
                key={activeTab.tabId}
                request={activeTab.request}
                response={activeTab.response}
                sending={activeTab.sending}
                streamActive={!!activeTab.grpcStreamId}
                streamLog={activeTab.grpcLog}
                streamError={activeTab.grpcError}
                onChange={setActiveRequest}
                onInvoke={send}
                onStartStream={() => {
                  const tab = tabs.find((t) => t.tabId === activeTabId);
                  if (tab && !tab.sending) startGrpcStream(tab);
                }}
                onCancelStream={() =>
                  cancelGrpcStream(activeTab.tabId, activeTab.grpcStreamId, 'Cancelled')
                }
                onClearLog={() => updateTab(activeTab.tabId, { grpcLog: [] })}
              />
            ) : isWebSocket(activeTab.request.url) ? (
              <WebSocketPanel
                status={activeTab.wsStatus}
                log={activeTab.wsLog}
                error={activeTab.wsError}
                onSend={sendWsFrame}
                onDisconnect={closeWsConnection}
                onClear={() => updateTab(activeTab.tabId, { wsLog: [] })}
              />
            ) : isMqtt(activeTab.request.url) ? (
              <MqttPanel
                status={activeTab.streamStatus}
                log={activeTab.streamLog}
                error={activeTab.streamError}
                onSubscribe={sendMqttSubscribe}
                onUnsubscribe={sendMqttUnsubscribe}
                onPublish={sendMqttPublish}
                onDisconnect={closeStreamConnection}
                onClear={() => updateTab(activeTab.tabId, { streamLog: [] })}
              />
            ) : isSocketIo(activeTab.request.url) ? (
              <SocketIoPanel
                status={activeTab.streamStatus}
                log={activeTab.streamLog}
                error={activeTab.streamError}
                onEmit={sendSocketIoEmit}
                onDisconnect={closeStreamConnection}
                onClear={() => updateTab(activeTab.tabId, { streamLog: [] })}
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

      {cloudAuthOpen && (
        <CloudAuthModal
          onClose={() => setCloudAuthOpen(false)}
          onSignIn={cloud.signIn}
          onSignUp={cloud.signUp}
        />
      )}

      {devicesOpen && <CloudDevicesModal onClose={() => setDevicesOpen(false)} />}

      {conflictModalOpen && (
        <ConflictResolveModal
          conflicts={cloud.conflicts}
          resolve={
            typeof cloud.resolveConflicts === 'function'
              ? (ids, choice) => cloud.resolveConflicts(undefined, ids, choice)
              : null
          }
          dismiss={cloud.dismissConflicts}
          onClose={() => setConflictModalOpen(false)}
        />
      )}

      {mockOpen && <MockServerModal store={store} onClose={() => setMockOpen(false)} />}

      {requestSettingsOpen && (
        <RequestSettingsModal
          request={activeTab.request}
          networkSettings={network.settings}
          onChange={(settings) => setActiveRequest({ ...activeTab.request, settings })}
          onClose={() => setRequestSettingsOpen(false)}
        />
      )}

      {appearanceOpen && (
        <AppearanceModal
          appearance={appearance.appearance}
          onChange={appearance.update}
          onClose={() => setAppearanceOpen(false)}
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
