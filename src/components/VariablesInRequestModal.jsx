import React from 'react';
import Modal from './Modal.jsx';
import Icon from './Icon.jsx';
import { collectRequestVariables } from '../lib/requestVariables.js';

const SCOPE_SHORT = { environment: 'E', collection: 'C', globals: 'G' };
const SCOPE_LABEL = { environment: 'Environment', collection: 'Collection', globals: 'Globals' };

// Postman-style quick view: every {{variable}} referenced by the current
// request, with its resolved value and an edit shortcut.
export default function VariablesInRequestModal({ request, lookup, onEdit, onClose }) {
  const names = collectRequestVariables(request);

  return (
    <Modal
      title="Variables in request"
      onClose={onClose}
      width={560}
      footer={
        <button className="mini-btn" onClick={onClose}>
          Close
        </button>
      }
    >
      {names.length === 0 ? (
        <p className="auth-hint">This request does not reference any variables.</p>
      ) : (
        <div className="request-vars-list" data-testid="request-vars-list">
          {names.map((name) => {
            const hit = lookup(name);
            return (
              <div key={name} className="request-vars-row">
                <code className="request-vars-name">{`{{${name}}}`}</code>
                <span className="request-vars-value">
                  {hit ? hit.value : 'variable is not defined'}
                </span>
                <span className={`var-scope-badge scope-${hit?.scope || 'unresolved'}`}>
                  {hit ? SCOPE_SHORT[hit.scope] || '•' : '!'}
                </span>
                <span className="request-vars-scope">
                  {hit ? SCOPE_LABEL[hit.scope] || hit.scope : 'Unresolved'}
                </span>
                <button
                  type="button"
                  className="mini-btn request-vars-edit"
                  onClick={() => onEdit(name)}
                >
                  <Icon name="edit" size={13} /> Edit
                </button>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
