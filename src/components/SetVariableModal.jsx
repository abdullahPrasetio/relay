import React, { useState } from 'react';
import Modal from './Modal.jsx';

// Create a variable from a selected value, choosing name + scope.
// Mirrors Postman's "Set as variable" from a text selection.
export default function SetVariableModal({ value, hasEnvironment, onCancel, onSave }) {
  const [name, setName] = useState('');
  const [scope, setScope] = useState(hasEnvironment ? 'environment' : 'globals');

  function submit() {
    const key = name.trim();
    if (!key) return;
    onSave({ key, value, scope });
  }

  return (
    <Modal
      title="Set as variable"
      onClose={onCancel}
      width={440}
      footer={
        <>
          <button className="mini-btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="send-btn" onClick={submit} disabled={!name.trim()}>
            Set
          </button>
        </>
      }
    >
      <div className="form-row">
        <label>Variable name</label>
        <input
          autoFocus
          value={name}
          placeholder="e.g. token"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </div>
      <div className="form-row">
        <label>Value</label>
        <input value={value} readOnly />
      </div>
      <div className="form-row">
        <label>Scope</label>
        <select value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="environment" disabled={!hasEnvironment}>
            Environment{hasEnvironment ? '' : ' (none active)'}
          </option>
          <option value="collection">Collection (active request’s)</option>
          <option value="globals">Globals</option>
        </select>
      </div>
      <p className="auth-hint">
        Use it later as <code>{'{{' + (name.trim() || 'name') + '}}'}</code>.
      </p>
    </Modal>
  );
}
