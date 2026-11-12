import React, { useState } from 'react';
import Modal from './Modal.jsx';

const SCOPE_LABEL = {
  environment: 'Environment',
  collection: 'Collection',
  globals: 'Globals',
};

// Edit an existing {{variable}}, or create it when the name is unresolved.
export default function EditVariableModal({
  variable,
  scopeOptions = [],
  scopeEditable = false,
  onCancel,
  onSave,
}) {
  const [value, setValue] = useState(variable?.value ?? '');
  const [scope, setScope] = useState(variable?.scope || scopeOptions[0]?.value || 'globals');

  function submit() {
    onSave({ name: variable.name, scope, value });
  }

  return (
    <Modal
      title={`${scopeEditable ? 'Set' : 'Edit'} {{${variable?.name || 'variable'}}}`}
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
        {scopeEditable ? (
          <select
            value={scope}
            data-testid="variable-scope"
            onChange={(e) => setScope(e.target.value)}
          >
            {scopeOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : (
          <input value={SCOPE_LABEL[scope] || scope || ''} readOnly />
        )}
      </div>
    </Modal>
  );
}
