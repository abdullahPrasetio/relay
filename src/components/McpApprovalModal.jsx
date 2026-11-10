import React, { useEffect, useRef, useState } from 'react';
import Modal from './Modal.jsx';

// Shown when an MCP client calls a non-read action and its policy requires
// asking. The caller already redacted `params`, so rendering them as JSON is
// safe; closing the modal counts as a denial.
export default function McpApprovalModal({ pending, onDecision }) {
  const [decided, setDecided] = useState(false);
  const decidedRef = useRef(false);
  const approvalId = pending?.approvalId || null;

  useEffect(() => {
    decidedRef.current = false;
    setDecided(false);
  }, [approvalId]);

  if (!pending) return null;

  const decide = (decision) => {
    if (decidedRef.current) return;
    decidedRef.current = true;
    setDecided(true);
    onDecision(decision);
  };

  const clientName = pending.client?.name || 'An AI client';

  return (
    <Modal
      title="AI permission request"
      onClose={() => decide('deny')}
      width={560}
      footer={
        <>
          <button
            type="button"
            className="mini-btn danger"
            data-testid="mcp-approval-deny"
            onClick={() => decide('deny')}
            disabled={decided}
          >
            Deny
          </button>
          <button
            type="button"
            className="mini-btn primary"
            data-testid="mcp-approval-once"
            onClick={() => decide('allow')}
            disabled={decided}
          >
            Allow once
          </button>
          {pending.policy === 'session' && (
            <button
              type="button"
              className="mini-btn"
              data-testid="mcp-approval-session"
              onClick={() => decide('allow_session')}
              disabled={decided}
            >
              Allow for session
            </button>
          )}
        </>
      }
    >
      <div className="mcp-approval">
        <div className="mcp-approval-meta">
          <strong>{clientName}</strong>
          <span>wants to run</span>
          <code>{pending.tool}.{pending.action}</code>
          <span className="badge">{pending.scope}</span>
        </div>

        <p className="mcp-approval-summary" data-testid="mcp-approval-summary">
          {pending.summary}
        </p>

        <details className="mcp-approval-details">
          <summary>Request details</summary>
          <pre className="mcp-config">{JSON.stringify(pending.params || {}, null, 2)}</pre>
        </details>
      </div>
    </Modal>
  );
}
