import React from 'react';
import Modal from './Modal.jsx';
import KeyValueEditor from './KeyValueEditor.jsx';

// Edits a collection's variables. Collection vars are overridden by the
// active environment's vars at request time.
export default function VariablesModal({ collection, onClose, onChange }) {
  return (
    <Modal title={`Variables · ${collection.name}`} onClose={onClose} width={560}>
      <KeyValueEditor
        rows={collection.variables || []}
        onChange={(variables) => onChange(variables)}
        keyPlaceholder="Variable"
        showType
      />
      <p className="auth-hint">
        Reference with <code>{'{{name}}'}</code>. The active environment overrides these.
      </p>
    </Modal>
  );
}
