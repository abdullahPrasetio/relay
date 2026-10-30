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

export const RETRY_MIN_MS = 1000;
export const RETRY_MAX_MS = 60000;

// Errors worth retrying automatically. Auth and validation failures are not:
// retrying them would spin until sign-in or the payload changes.
const NON_RETRYABLE_CODES = new Set([
  'unauthorized',
  'forbidden',
  'not_found',
  'not_attached',
  'busy',
  'validation',
]);

export function isRetryableError(error) {
  if (!error) return false;
  const status = Number(error.status) || 0;
  if (status === 401 || status === 403 || status === 404 || status === 422) return false;
  return !NON_RETRYABLE_CODES.has(String(error.code || '').toLowerCase());
}

// Pure retry timer: no React and no timers of its own unless injected, so the
// backoff contract is unit-testable. One attempt is scheduled at a time;
// `fail()` re-arms with `nextDelay(attempt)` (0-based, capped by maxDelayMs),
// `reset()` cancels and forgets the attempt count, `stop()` also disables it.
export function createRetryScheduler({
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle),
  nextDelay = () => RETRY_MIN_MS,
  onRun = () => {},
  maxDelayMs = RETRY_MAX_MS,
} = {}) {
  const cap =
    Number.isFinite(Number(maxDelayMs)) && Number(maxDelayMs) >= 0
      ? Number(maxDelayMs)
      : RETRY_MAX_MS;
  let attempt = 0;
  let handle = null;
  let delay = null;
  let stopped = false;

  const clearTimer = () => {
    if (handle == null) return;
    try {
      cancel(handle);
    } catch {
      // The timer may already be gone; nothing to clean up.
    }
    handle = null;
  };

  const delayFor = (index) => {
    let value;
    try {
      value = Number(nextDelay(index));
    } catch {
      value = NaN;
    }
    if (!Number.isFinite(value) || value < 0) value = Math.min(cap, RETRY_MIN_MS);
    return Math.min(cap, Math.max(0, Math.round(value)));
  };

  const scheduleNext = () => {
    if (stopped || handle != null) return null;
    const wait = delayFor(attempt);
    attempt += 1;
    delay = wait;
    let fired = false;
    const timer = schedule(() => {
      fired = true;
      handle = null;
      delay = null;
      if (!stopped) onRun();
    }, wait);
    // A synchronous `schedule` (tests) may run the callback before returning.
    if (!fired) handle = timer;
    return wait;
  };

  return {
    get attempt() {
      return attempt;
    },
    get retryInMs() {
      return delay;
    },
    get scheduled() {
      return handle != null || delay != null;
    },
    get stopped() {
      return stopped;
    },
    start() {
      stopped = false;
      return scheduleNext();
    },
    scheduleNext,
    fail() {
      return scheduleNext();
    },
    reset() {
      clearTimer();
      attempt = 0;
      delay = null;
    },
    stop() {
      stopped = true;
      clearTimer();
      attempt = 0;
      delay = null;
    },
  };
}


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
  const [retryInMs, setRetryInMs] = useState(null);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const schedulerRef = useRef(null);
  const runSyncRef = useRef(null);

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

  // Recover edits made while the app was closed: the controller diffs against
  // the persisted baseline and queues only real changes (idempotent).
  const signedIn = session.signedIn;
  const activeId = store.activeWorkspaceId;
  useEffect(() => {
    if (!available || !signedIn || !activeId) return undefined;
    controller.captureOfflineEdits(activeId);
    return undefined;
  }, [available, signedIn, activeId, controller]);

  // Track local edits while linked so an offline period never loses them. The
  // controller diffs against its last snapshot and persists the queue; a no-op
  // edit writes nothing.
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

  // Feed a sync result back into the retry scheduler: offline or retryable
  // failures arm the next attempt with the controller's backoff; success (or
  // a state that needs the user, like conflicts) disarms it.
  const reportSyncResult = useCallback(
    (workspaceId, res) => {
      const scheduler = schedulerRef.current;
      if (!scheduler) return;
      const state = workspaceId != null ? controller.status(workspaceId).status : null;
      const offline = state === 'offline';
      const retry = res?.ok ? offline : isRetryableError(res?.error);
      if (!retry) {
        scheduler.reset();
        setRetryInMs(null);
        setRetryAttempt(0);
        return;
      }
      const wait = scheduler.fail();
      setRetryInMs(wait);
      setRetryAttempt(scheduler.attempt);
    },
    [controller]
  );

  const syncWorkspace = useCallback(
    async (workspaceId) => {
      const id = workspaceId || storeRef.current.activeWorkspaceId || null;
      if (!id) {
        const res = {
          ok: false,
          error: { code: 'not_found', message: 'No workspace selected.', status: 0 },
        };
        setError(res.error);
        return res;
      }
      const res = await run(() => controller.sync(id));
      reportSyncResult(id, res);
      return res;
    },
    [controller, run, reportSyncResult]
  );
  runSyncRef.current = syncWorkspace;

  // One scheduler per signed-in session. A timer fires a sync; the sync result
  // re-arms or resets it through reportSyncResult. Sign-out and unmount cancel
  // the pending timer.
  useEffect(() => {
    if (!available || !signedIn) {
      schedulerRef.current = null;
      setRetryInMs(null);
      setRetryAttempt(0);
      return undefined;
    }
    const scheduler = createRetryScheduler({
      nextDelay: (attempt) => controller.nextSyncDelay(attempt),
      onRun: () => {
        const id = storeRef.current.activeWorkspaceId || null;
        if (!id) {
          scheduler.reset();
          setRetryInMs(null);
          return;
        }
        runSyncRef.current?.(id);
      },
    });
    schedulerRef.current = scheduler;

    // A workspace that was left offline must resume on its own after a
    // restart, not wait for a manual click.
    if (activeId && controller.status(activeId).status === 'offline') {
      const wait = scheduler.fail();
      setRetryInMs(wait);
      setRetryAttempt(scheduler.attempt);
    }

    return () => {
      scheduler.stop();
      if (schedulerRef.current === scheduler) schedulerRef.current = null;
      setRetryInMs(null);
      setRetryAttempt(0);
    };
  }, [available, signedIn, controller, activeId]);

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
    (workspaceId) => syncWorkspace(workspaceId),
    [syncWorkspace]
  );

  // Called after a member is removed: rotate the workspace key and re-encrypt
  // the local secrets with it. Shares the busy/error surface with sync so the
  // UI can show one in-flight indicator at a time.
  const reencryptSecrets = useCallback(
    (workspaceId) => {
      const id = workspaceId || storeRef.current.activeWorkspaceId || null;
      if (!id) {
        const res = {
          ok: false,
          error: { code: 'not_found', message: 'No workspace selected.', status: 0 },
        };
        setError(res.error);
        return Promise.resolve(res);
      }
      return run(() => controller.reencryptSecrets(id));
    },
    [controller, run]
  );

  const resolveConflicts = useCallback(
    (workspaceId, ids, choice = 'local') => {
      const id = workspaceId || storeRef.current.activeWorkspaceId;
      setError(null);
      const res = controller.resolveConflicts(id, ids, choice);
      if (!res.ok) setError(res.error);
      return res;
    },
    [controller]
  );

  const dismissConflicts = useCallback(
    (workspaceId, ids = null) => resolveConflicts(workspaceId, ids, 'local'),
    [resolveConflicts]
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
    retryInMs,
    retryAttempt,
    signIn,
    signUp,
    signOut,
    attach,
    detach,
    syncNow,
    reencryptSecrets,
    resolveConflicts,
    dismissConflicts,
    nextSyncDelay: controller.nextSyncDelay,
  };
}
