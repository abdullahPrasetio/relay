import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import RequestPanel from './components/RequestPanel.jsx';
import ResponsePanel from './components/ResponsePanel.jsx';
import EnvBar from './components/EnvBar.jsx';
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
import { mergeVars, resolveRequest, varsToMap } from './lib/variables.js';
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
  flattenRequests,
  findFolder,
} from './lib/collectionTree.js';

const hasBridge = typeof window !== 'undefined' && !!window.api;

// Request ids correlate a send with http:abort. randomUUID needs a secure
// context (true for file:// and localhost); fall back defensively.
function newRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
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
    dirty: false,
    savedCollectionId: null,
  };
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
      if (activeEnv) {
        store.setEnvironments(
          store.environments.map((e) =>
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
        store.setCollections(
          store.collections.map((c) =>
            c.id === owningCollection.id
              ? { ...c, variables: objToVarList(colObj, c.variables) }
              : c
          )
        );
      }
      store.setGlobals(objToVarList(globObj, store.globals));
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

  // Cancel whatever this tab is currently sending. Unknown ids are a no-op.
  const abort = useCallback(async () => {
    const tab = tabs.find((t) => t.tabId === activeTabId);
    if (!tab?.sendingId || !hasBridge) return;
    try {
      await window.api.abortRequest(tab.sendingId);
    } catch {
      /* a request that already finished cannot be aborted */
    }
  }, [tabs, activeTabId]);

  const send = useCallback(async () => {
    const tab = tabs.find((t) => t.tabId === activeTabId);
    if (!tab || !tab.request.url.trim() || tab.sending) return;

    const requestId = newRequestId();
    updateTab(activeTabId, {
      sending: true,
      sendingId: requestId,
      response: null,
      testResults: null,
    });

    try {
      const owningCollection = findRequestCollection(store.collections, tab.request.id);

      // Mutable scope objects for scripts to read/write.
      const envObj = varsToMap(activeEnv);
      const colObj = varsToMap(owningCollection?.variables);
      const globObj = varsToMap(store.globals);
      const scriptContext = { environment: envObj, collection: colObj, globals: globObj };

      // 1. Pre-request script: collection script runs first, then the request's.
      //    Scripts get pm.request and may mutate its body/headers/url/method.
      const preScript = combinedPreRequest(tab.request, owningCollection);
      const pre = await runPreRequest(preScript, scriptContext, tab.request);
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
      //    Scopes: globals < collection < environment.
      const vars = { ...globObj, ...colObj, ...envObj };
      const withAuth = withEffectiveAuth(effectiveRequest, owningCollection);
      const resolved = resolveRequest(withAuth, vars);

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
      const testResults = cancelled
        ? { ran: false, results: [] }
        : await runTests(
            combinedTests(tab.request, owningCollection),
            result,
            scriptContext,
            resolved
          );

      // 5. Persist any variable mutations from pre-request + tests.
      persistVarMutations(envObj, colObj, globObj, owningCollection);

      // Collect console output from both script phases for the Console tab.
      const consoleLogs = [...(pre.logs || []), ...(testResults.logs || [])];
      const responseWithDiag =
        result && typeof result === 'object' ? { ...result, consoleLogs } : result;

      updateTab(activeTabId, { response: responseWithDiag, testResults });

      store.addHistory({
        id: `h_${Date.now()}`,
        at: new Date().toISOString(),
        method: resolved.method,
        url: result.ok && result.sent ? result.sent.url : resolved.url,
        status: result.ok ? result.status : null,
        ok: result.ok,
        snapshot: tab.request,
        sent: result.ok ? result.sent : null,
      });
    } finally {
      updateTab(activeTabId, { sending: false, sendingId: null });
    }
  }, [tabs, activeTabId, activeEnv, store, updateTab, persistVarMutations, transport]);

  const showCode = useCallback(() => {
    const tab = tabs.find((t) => t.tabId === activeTabId);
    if (!tab) return;
    const owningCollection = findRequestCollection(store.collections, tab.request.id);
    const vars = mergeVars(owningCollection, activeEnv, store.globals);
    const resolved = resolveRequest(withEffectiveAuth(tab.request, owningCollection), vars);
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
      });
    },
    [store.collections]
  );

  // Persist variable mutations produced by a completed run.
  const persistRunScopes = useCallback(
    (scopes, collection) => {
      if (activeEnv) {
        store.setEnvironments(
          store.environments.map((e) =>
            e.id === activeEnv.id ? { ...e, variables: objToVarList(scopes.environment, e.variables) } : e
          )
        );
      } else {
        // No active environment: fold env-scope writes into globals so they persist.
        for (const [k, v] of Object.entries(scopes.environment || {})) scopes.globals[k] = v;
      }
      if (collection) {
        store.setCollections(
          store.collections.map((c) =>
            c.id === collection.id ? { ...c, variables: objToVarList(scopes.collection, c.variables) } : c
          )
        );
      }
      if (scopes.globals) store.setGlobals(objToVarList(scopes.globals, store.globals));
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

  // Keyboard: Cmd/Ctrl+S saves the active request.
  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

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
    [activeTabId]
  );

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
            <ResponsePanel
              response={activeTab.response}
              sending={activeTab.sending}
              testResults={activeTab.testResults}
              onSaveExample={saveExample}
              onSetVariable={openSetVariable}
            />
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
