import React from 'react';
import Modal from './Modal.jsx';
import ValidationRulesEditor from './ValidationRulesEditor.jsx';

export default function ValidationRulesModal({ node, onClose, onChange }) {
  if (!node) return null;
  return (
    <Modal title={`Validation · ${node.name}`} onClose={onClose} width={760}>
      <ValidationRulesEditor
        container={node}
        fieldValidations={node.fieldValidations}
        responseValidations={node.responseValidations}
        onChange={onChange}
      />
    </Modal>
  );
}
