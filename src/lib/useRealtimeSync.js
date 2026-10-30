// React binding for live workspace changes.
//
// The main process owns the SSE connection; the renderer only subscribes
// through the preload bridge:
//
//   window.api.cloud.startStream(workspaceId)  -> subscribe to that workspace
//   window.api.cloud.stopStream()              -> unsubscribe
//   window.api.cloud.onChange(cb)              -> cb({ seq }) per change event
//
// Every change event asks for a sync, but at most once per 500 ms so a burst
// of edits from a teammate does not turn into a burst of syncs. Presence is a
// 30s heartbeat for the active workspace. When the desktop bridge is absent
// (web preview, unit tests) the hook is a safe no-op and `live` stays false.

import { useEffect, useRef, useState } from 'react';

export const SYNC_THROTTLE_MS = 500;
export const PRESENCE_INTERVAL_MS = 30000;

// Leading + trailing throttle. The first event runs immediately; events that
// arrive inside the window coalesce into a single trailing call. This is a
// plain function (no React) so the timing rules stay unit-testable.
export function createChangeThrottle({
  run,
  intervalMs = SYNC_THROTTLE_MS,
  now = Date.now,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle),
} = {}) {
  if (typeof run !== 'function') {
    throw new TypeError('createChangeThrottle requires a run function');
  }

  let lastRunAt = -Infinity;
  let handle = null;
  let closed = false;

  function invoke() {
    lastRunAt = now();
    try {
      const result = run();
      // A rejected sync must never surface as an unhandled rejection.
      if (result && typeof result.then === 'function') {
        result.then(undefined, () => {});
      }
    } catch {
      /* a failing sync must not break the stream */
    }
  }

  return {
    trigger() {
      if (closed) return;
      const elapsed = now() - lastRunAt;
      if (elapsed >= intervalMs) {
        if (handle !== null) {
          cancel(handle);
          handle = null;
        }
        invoke();
        return;
      }
      if (handle !== null) return;
      handle = schedule(() => {
        handle = null;
        if (!closed) invoke();
      }, intervalMs - elapsed);
    },
    close() {
      closed = true;
      if (handle !== null) {
        cancel(handle);
        handle = null;
      }
    },
    get pending() {
      return handle !== null;
    },
    get lastRunAt() {
      return lastRunAt;
    },
  };
}

function bridgeCloud() {
  if (typeof window === 'undefined') return null;
  const cloud = window.api?.cloud;
  return cloud && typeof cloud === 'object' ? cloud : null;
}

/** Fire-and-forget an IPC call; returns false when the method is missing. */
function call(cloud, method, payload) {
  if (typeof cloud?.[method] !== 'function') return false;
  try {
    const result = cloud[method](payload);
    if (result && typeof result.then === 'function') result.then(undefined, () => {});
    return true;
  } catch {
    return false;
  }
}

function statusIsLive(status) {
  if (!status) return false;
  if (typeof status === 'boolean') return status;
  return status.live === true || status.state === 'open' || status.state === 'live';
}

export function useRealtimeSync({
  workspaceId = null,
  entityId = null,
  syncNow,
  throttleMs = SYNC_THROTTLE_MS,
  presenceMs = PRESENCE_INTERVAL_MS,
} = {}) {
  const [live, setLive] = useState(false);
  const syncRef = useRef(syncNow);
  syncRef.current = syncNow;
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;

  // Subscribe to the workspace change stream.
  useEffect(() => {
    if (!workspaceId) {
      setLive(false);
      return undefined;
    }
    const cloud = bridgeCloud();
    if (!cloud || typeof cloud.startStream !== 'function' || typeof cloud.onChange !== 'function') {
      setLive(false);
      return undefined;
    }

    const throttle = createChangeThrottle({
      intervalMs: throttleMs,
      run: () => {
        const fn =
          typeof syncRef.current === 'function' ? syncRef.current : cloud.syncNow;
        if (typeof fn !== 'function') return;
        return fn(workspaceRef.current);
      },
    });

    const unsubscribe = cloud.onChange((event) => {
      if (!Number.isFinite(event?.seq)) return;
      setLive(true);
      throttle.trigger();
    });
    // Optional richer signal from the main process; `onChange` alone is enough
    // to flip `live` on the first event.
    const unsubscribeStatus =
      typeof cloud.onStreamStatus === 'function'
        ? cloud.onStreamStatus((status) => setLive(statusIsLive(status)))
        : null;

    call(cloud, 'startStream', workspaceId);
    setLive(false);

    return () => {
      throttle.close();
      try {
        unsubscribe?.();
      } catch {
        /* bridge already torn down */
      }
      try {
        unsubscribeStatus?.();
      } catch {
        /* ignore */
      }
      call(cloud, 'stopStream');
      setLive(false);
    };
  }, [workspaceId, throttleMs]);

  // Presence heartbeat for the active workspace. `entityId` names who is
  // present, so without one there is nothing to announce.
  useEffect(() => {
    if (!workspaceId || !entityId) return undefined;
    const cloud = bridgeCloud();
    if (!cloud || typeof cloud.setPresence !== 'function') return undefined;

    const beat = () => call(cloud, 'setPresence', { workspaceId, entityId });
    beat();
    const timer = setInterval(beat, presenceMs);
    return () => clearInterval(timer);
  }, [workspaceId, entityId, presenceMs]);

  return { live };
}
