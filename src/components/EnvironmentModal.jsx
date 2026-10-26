import React from 'react';
import Modal from './Modal.jsx';
import KeyValueEditor from './KeyValueEditor.jsx';

// Edits one environment's variables in a proper modal (not a cramped popover).
export default function EnvironmentModal({ environment, onClose, onChange }) {
  return (
    <Modal title={`Environment · ${environment.name}`} onClose={onClose} width={560}>
      <KeyValueEditor
        rows={environment.variables || []}
        onChange={(variables) => onChange(variables)}
        keyPlaceholder="Variable"
      />
      <p className="auth-hint">
        Reference with <code>{'{{name}}'}</code> in the URL, params, headers, body, or scripts.
      </p>
    </Modal>
  );
}
