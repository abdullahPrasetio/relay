import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { newWorkspace, migrateToWorkspaces, SCHEMA_VERSION } from './workspace.js';
import { hydrateWorkspaceSecrets, sealWorkspaceSecrets } from './secretVars.js';

// Persisted shape (workspace-aware):
//   { schemaVersion, workspaces: [{id,name,collections,environments,globals,history,activeEnvId}],
//     activeWorkspaceId }
// Legacy flat data is migrated into a "Default" workspace on load.
// Network settings are NOT persisted here: the main process owns them.
const hasBridge = typeof window !== 'undefined' && !!window.api;

async function loadInitial() {
  if (hasBridge) {
    try {
      return await window.api.loadData();
    } catch {
      /* ignore */
    }
  }
  try {
    const raw = localStorage.getItem('rest-tamer-data');
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return {};
}

async function persist(data) {
  if (hasBridge) {
    try {
      await window.api.saveData(data);
      return;
    } catch {
      /* ignore */
    }
  }
  try {
    localStorage.setItem('rest-tamer-data', JSON.stringify(data));
  } catch {
    /* ignore */
  }
}

export function useStore() {
  const [workspaces, setWorkspaces] = useState([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(null);
  const [loaded, setLoaded] = useState(false);
  // Surfaced to the UI: a failed seal/write must not be silent, because
  // skipping the write leaves the last change unsaved (never plaintext on disk).
  const [saveError, setSaveError] = useState('');
  const saveTimer = useRef(null);

  useEffect(() => {
    let mounted = true;
    loadInitial().then(async (data) => {
      if (!mounted) return;
      const migrated = migrateToWorkspaces(data);
      // Ciphertext exists only on disk; React state holds plaintext so inputs
      // and the runner resolve secret variables normally.
      const hydrated = await hydrateWorkspaceSecrets(migrated.workspaces);
      if (!mounted) return;
      // schemaVersion is written on save; it is not renderer state.
      setWorkspaces(hydrated);
      setActiveWorkspaceId(migrated.activeWorkspaceId);
      setLoaded(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        // Seal a deep copy at the persistence boundary; in-memory state keeps
        // plaintext. Without a bridge this is a no-op (localStorage dev only).
        const sealed = await sealWorkspaceSecrets(workspaces);
        await persist({
          schemaVersion: SCHEMA_VERSION,
          workspaces: sealed,
          activeWorkspaceId,
        });
        setSaveError('');
      } catch (err) {
        // Encryption unavailable (or failed): skip this write rather than
        // ever persisting plaintext. The next edit retries.
        setSaveError(err?.message || String(err));
      }
    }, 300);
  }, [workspaces, activeWorkspaceId, loaded]);

  const active = useMemo(
    () => workspaces.find((w) => w.id === activeWorkspaceId) || workspaces[0] || null,
    [workspaces, activeWorkspaceId]
  );

  // Patch a field on the active workspace immutably.
  const patchActive = useCallback(
    (patch) => {
      setWorkspaces((prev) =>
        prev.map((w) => (w.id === activeWorkspaceId ? { ...w, ...patch } : w))
      );
    },
    [activeWorkspaceId]
  );

  // Field setters mirror the old API but operate on the active workspace.
  // Each accepts a value or an updater function. One stable helper, memoized
  // on the active workspace id (keeps hooks order fixed across renders).
  const setField = useCallback(
    (field, valueOrFn) => {
      setWorkspaces((prev) =>
        prev.map((w) => {
          if (w.id !== activeWorkspaceId) return w;
          const next = typeof valueOrFn === 'function' ? valueOrFn(w[field]) : valueOrFn;
          return { ...w, [field]: next };
        })
      );
    },
    [activeWorkspaceId]
  );

  const setCollections = useCallback((v) => setField('collections', v), [setField]);
  const setEnvironments = useCallback((v) => setField('environments', v), [setField]);
  const setGlobals = useCallback((v) => setField('globals', v), [setField]);
  const setHistory = useCallback((v) => setField('history', v), [setField]);
  const setActiveEnvId = useCallback((v) => setField('activeEnvId', v), [setField]);

  const addHistory = useCallback(
    (entry) => {
      setHistory((prev) => [entry, ...(prev || [])].slice(0, 100));
    },
    [setHistory]
  );

  // ---- Workspace management ----
  const createWorkspace = useCallback((name) => {
    const ws = newWorkspace(name || 'New Workspace');
    setWorkspaces((prev) => [...prev, ws]);
    setActiveWorkspaceId(ws.id);
    return ws.id;
  }, []);

  const renameWorkspace = useCallback((id, name) => {
    setWorkspaces((prev) => prev.map((w) => (w.id === id ? { ...w, name } : w)));
  }, []);

  const deleteWorkspace = useCallback(
    (id) => {
      setWorkspaces((prev) => {
        if (prev.length <= 1) return prev; // never delete the last workspace
        const next = prev.filter((w) => w.id !== id);
        if (id === activeWorkspaceId) setActiveWorkspaceId(next[0].id);
        return next;
      });
    },
    [activeWorkspaceId]
  );

  const switchWorkspace = useCallback((id) => setActiveWorkspaceId(id), []);

  return {
    loaded,
    saveError,
    // Active workspace data (same field names the app already uses).
    collections: active?.collections || [],
    setCollections,
    environments: active?.environments || [],
    setEnvironments,
    globals: active?.globals || [],
    setGlobals,
    history: active?.history || [],
    addHistory,
    setHistory,
    activeEnvId: active?.activeEnvId ?? null,
    setActiveEnvId,
    // Workspace surface.
    workspaces,
    activeWorkspaceId,
    activeWorkspace: active,
    createWorkspace,
    renameWorkspace,
    deleteWorkspace,
    switchWorkspace,
  };
}
