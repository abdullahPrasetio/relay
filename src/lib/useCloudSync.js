// React binding for the cloud controller.
//
// `useCloudSync` keeps the controller in a ref-backed adapter so successive
// sync steps always see the latest workspace data even though React state
// updates are asynchronous. When the desktop bridge is missing (web preview,
// unit tests) every action degrades to a safe no-op and the status stays
// "local".

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createCloudController } from './cloudController.js';

function bridge() {
  if (typeof window === 'undefined') return null;
  const cloud = window.api?.cloud;
  if (!cloud || typeof cloud.login !== 'function') return null;
  return cloud;
}

const IDLE_SESSION = { signedIn: false, user: null };

export function useCloudSync(store) {
  const cloud = useMemo(bridge, []);
  const available = !!cloud;

  const workspacesRef = useRef(store.workspaces);
  const storeRef = useRef(store);
  storeRef.current = store;
  workspacesRef.current = store.workspaces;

  const [session, setSession] = useState(IDLE_SESSION);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const controller = useMemo(
    () =>
      createCloudController({
        cloud,
        getWorkspace: (id) => workspacesRef.current.find((w) => w.id === id) || null,
        // Update the mirror first: the controller performs several synchronous
        // steps per sync and must not read stale React state in between.
        patchWorkspace: (id, patch) => {
          workspacesRef.current = workspacesRef.current.map((w) => {
            if (w.id !== id) return w;
            const next = typeof patch === 'function' ? patch(w) : patch;
            return next ? { ...w, ...next } : w;
          });
          storeRef.current.patchWorkspace?.(id, patch);
        },
        now: Date.now,
      }),
    [cloud]
  );

  // Ask the main process whether a refresh token survived the last session.
  useEffect(() => {
    if (!available) return undefined;
    let mounted = true;
    controller.refreshSession().then((res) => {
      if (!mounted || !res.ok) return;
      setSession({ signedIn: res.data.signedIn, user: res.data.user });
    });
    return () => {
      mounted = false;
    };
  }, [available, controller]);

  // Track local edits while linked so an offline period never loses them. The
  // controller diffs against its last snapshot and persists the queue; a no-op
  // edit writes nothing.
  const signedIn = session.signedIn;
  const activeId = store.activeWorkspaceId;
  useEffect(() => {
    if (!available || !signedIn || !activeId) return undefined;
    const linked = workspacesRef.current.find(
      (w) => w.id === activeId && w.cloud && w.cloud.remoteId
    );
    if (!linked) return undefined;
    const timer = setTimeout(() => {
      controller.enqueue(activeId);
    }, 600);
    return () => clearTimeout(timer);
  }, [available, signedIn, activeId, controller, store.collections, store.environments, store.globals]);

  const run = useCallback(
    async (action) => {
      setBusy(true);
      setError(null);
      try {
        const res = await action();
        if (!res?.ok) setError(res?.error || { code: 'internal', message: 'Cloud request failed' });
        return res;
      } catch (err) {
        const res = { ok: false, error: { code: 'internal', message: err?.message || String(err), status: 0 } };
        setError(res.error);
        return res;
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const signIn = useCallback(
    async (credentials) => {
      const res = await controller.signIn(credentials);
      if (res.ok) {
        setSession({ signedIn: true, user: res.data.user });
        setError(null);
      } else {
        setError(res.error);
      }
      return res;
    },
    [controller]
  );

  const signUp = useCallback(
    async (details) => {
      const res = await controller.signUp(details);
      if (res.ok) {
        setSession({ signedIn: true, user: res.data.user });
        setError(null);
      } else {
        setError(res.error);
      }
      return res;
    },
    [controller]
  );

  const signOut = useCallback(async () => {
    const res = await controller.signOut();
    setSession(IDLE_SESSION);
    return res;
  }, [controller]);

  const attach = useCallback(
    (workspaceId) => run(() => controller.attach(workspaceId)),
    [controller, run]
  );

  const detach = useCallback(
    async (workspaceId) => {
      setError(null);
      const res = await controller.detach(workspaceId);
      if (!res.ok) setError(res.error);
      return res;
    },
    [controller]
  );

  const syncNow = useCallback(
    (workspaceId) =>
      run(() => controller.sync(workspaceId || storeRef.current.activeWorkspaceId)),
    [controller, run]
  );

  const dismissConflicts = useCallback(
    (workspaceId) => {
      const id = workspaceId || storeRef.current.activeWorkspaceId;
      setError(null);
      return controller.dismissConflicts(id);
    },
    [controller]
  );

  const conflicts = Array.isArray(store.activeWorkspace?.cloud?.conflicts)
    ? store.activeWorkspace.cloud.conflicts
    : [];

  // `busy` is the renderer's optimistic overlay; the persisted state covers
  // syncs started elsewhere (or a reload mid-sync).
  const status = !available
    ? 'local'
    : busy
      ? 'syncing'
      : controller.status(store.activeWorkspaceId).status;

  return {
    available,
    status,
    user: session.user,
    signedIn: session.signedIn,
    conflicts,
    error,
    busy,
    signIn,
    signUp,
    signOut,
    attach,
    detach,
    syncNow,
    dismissConflicts,
    nextSyncDelay: controller.nextSyncDelay,
  };
}
