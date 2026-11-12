import React, { useState } from 'react';
import Modal from './Modal.jsx';

const SCOPE_LABEL = {
  environment: 'Environment',
  collection: 'Collection',
  globals: 'Globals',
};

// Edit the value of an existing {{variable}} in the scope where it resolves.
export default function EditVariableModal({ variable, onCancel, onSave }) {
  const [value, setValue] = useState(variable?.value ?? '');

  function submit() {
    onSave({ name: variable.name, scope: variable.scope, value });
  }

  return (
    <Modal
      title={`Edit {{${variable?.name || 'variable'}}}`}
      onClose={onCancel}
      width={440}
      footer={
        <>
          <button className="mini-btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="send-btn" data-testid="variable-save" onClick={submit}>
            Save
          </button>
        </>
      }
    >
      <div className="form-row">
        <label>Variable</label>
        <input value={variable?.name || ''} readOnly />
      </div>
      <div className="form-row">
        <label>Value</label>
        <input
          autoFocus
          data-testid="variable-value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </div>
      <div className="form-row">
        <label>Scope</label>
        <input value={SCOPE_LABEL[variable?.scope] || variable?.scope || ''} readOnly />
      </div>
    </Modal>
  );
}
