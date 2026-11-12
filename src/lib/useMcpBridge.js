// Renderer binding for the MCP endpoint.
//
// Two jobs:
//   1. Answer `mcp:invoke` events from the main process by running the action
//      and replying on `mcp:invoke-result`. Calls are serialized so a read can
//      never interleave with a write.
//   2. Queue `mcp:approval` events and expose the front of the queue plus a
//      resolver for the approval modal.
//
// Params shown in the approval modal are redacted with the active workspace's
// secret pool, so a declared secret is never rendered in the dialog.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createMcpActions } from './mcpActions.js';
import { redactForMcp, secretPool } from './mcpRedact.js';

function bridge() {
  if (typeof window === 'undefined') return null;
  const mcp = window.api?.mcp;
  if (!mcp || typeof mcp.onInvoke !== 'function') return null;
  return mcp;
}

export function useMcpBridge({ store, cloud, appearance }) {
  const actions = useMemo(
    () => createMcpActions({ store, cloud, appearance }),
    [store, cloud, appearance]
  );
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  // Secret values of the active workspace, refreshed every render so a newly
  // typed secret is masked immediately.
  const poolRef = useRef([]);
  poolRef.current = useMemo(
    () => (store?.activeWorkspace ? secretPool(store.activeWorkspace) : []),
    [store]
  );

  const [pendingApproval, setPendingApproval] = useState(null);
  const pendingRef = useRef(null);
  const approvalQueue = useRef([]);
  const invokeQueue = useRef(Promise.resolve());

  const resolveApproval = useCallback((decision) => {
    const current = pendingRef.current;
    if (!current) return;
    const api = bridge();
    try {
      api?.respondApproval({
        approvalId: current.approvalId,
        decision: decision === 'allow' || decision === 'allow_session' ? decision : 'deny',
      });
    } catch {
      /* the window is going away; main fails the call itself */
    }
    const next = approvalQueue.current.shift() || null;
    pendingRef.current = next;
    setPendingApproval(next);
  }, []);

  const enqueueApproval = useCallback((payload) => {
    if (!payload || typeof payload !== 'object') return;
    const display = {
      ...payload,
      params: redactForMcp(payload.params || {}, poolRef.current),
    };
    if (pendingRef.current) {
      approvalQueue.current.push(display);
      return;
    }
    pendingRef.current = display;
    setPendingApproval(display);
  }, []);

  const handleInvoke = useCallback((payload) => {
    // Chain on the previous call so actions never overlap.
    invokeQueue.current = invokeQueue.current
      .then(async () => {
        const { callId, tool, action, params, client } = payload || {};
        if (!callId) return;
        const api = bridge();
        try {
          const result = await actionsRef.current.invoke({
            tool,
            action,
            params,
            clientScopes: client?.scopes || [],
          });
          api?.respondInvoke({
            callId,
            ok: result?.ok === true,
            result: result?.ok === true ? result.data : undefined,
            sensitive: result?.sensitive === true,
            error: result?.ok === true ? undefined : result?.error,
          });
        } catch (err) {
          api?.respondInvoke({
            callId,
            ok: false,
            error: { code: 'renderer_error', message: err?.message || String(err) },
          });
        }
      })
      .catch(() => {
        /* a failed action never blocks the queue */
      });
  }, []);

  useEffect(() => {
    const api = bridge();
    if (!api) return undefined;
    const offInvoke = api.onInvoke(handleInvoke);
    const offApproval =
      typeof api.onApproval === 'function' ? api.onApproval(enqueueApproval) : null;
    return () => {
      if (typeof offInvoke === 'function') offInvoke();
      if (typeof offApproval === 'function') offApproval();
    };
  }, [handleInvoke, enqueueApproval]);

  // Closing the app ends every protocol session this renderer opened.
  useEffect(
    () => () => {
      try {
        actionsRef.current.dispose();
      } catch {
        /* nothing left to close */
      }
    },
    []
  );

  return { pendingApproval, resolveApproval };
}
