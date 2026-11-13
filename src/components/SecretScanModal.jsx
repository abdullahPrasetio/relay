import React, { useMemo } from 'react';
import Modal from './Modal.jsx';
import {
  markSecretInWorkspace,
  scanWorkspaceSecrets,
} from '../lib/secretScanner.js';

export default function SecretScanModal({ workspace, onChangeWorkspace, onClose }) {
  const candidates = useMemo(() => scanWorkspaceSecrets(workspace), [workspace]);

  function mark(candidate) {
    onChangeWorkspace(markSecretInWorkspace(workspace, candidate));
  }

  return (
    <Modal
      title="Secret scan"
      onClose={onClose}
      width={680}
      footer={
        <button type="button" className="mini-btn" onClick={onClose}>
          Close
        </button>
      }
    >
      <p className="auth-hint" style={{ marginTop: 0 }}>
        Values below look like credentials but are stored as normal variables.
        Marking one as secret makes MCP redact it and masks it in the UI.
      </p>

      {candidates.length === 0 ? (
        <div className="secret-scan-empty">
          No likely secrets found. Values already marked secret or named like
          credentials are excluded.
        </div>
      ) : (
        <ul className="secret-scan-list" data-testid="secret-scan-list">
          {candidates.map((candidate) => (
            <li key={candidate.id} className="secret-scan-row">
              <div className="secret-scan-copy">
                <span className="secret-scan-key">{candidate.key}</span>
                <span className="secret-scan-scope">{candidate.label}</span>
                <code className="secret-scan-preview">{candidate.preview}</code>
              </div>
              <button
                type="button"
                className="mini-btn"
                data-testid={`secret-scan-mark-${candidate.id}`}
                onClick={() => mark(candidate)}
              >
                Mark as secret
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
