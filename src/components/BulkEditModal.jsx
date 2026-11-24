import React, { useState } from 'react';
import Modal from './Modal.jsx';

export default function BulkEditModal({
  title,
  initialText,
  hint,
  placeholder,
  onClose,
  onApply,
  testId = 'bulk-edit',
}) {
  const [text, setText] = useState(initialText || '');
  return (
    <Modal
      title={title}
      onClose={onClose}
      width={640}
      footer={
        <>
          <button type="button" className="mini-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="send-btn"
            data-testid={`${testId}-apply`}
            onClick={() => onApply(text)}
          >
            Apply
          </button>
        </>
      }
    >
      {hint && <p className="auth-hint" style={{ marginTop: 0 }}>{hint}</p>}
      <textarea
        className="body-text kv-bulk-text"
        data-testid={`${testId}-text`}
        value={text}
        placeholder={placeholder}
        spellCheck={false}
        autoFocus
        onChange={(event) => setText(event.target.value)}
      />
    </Modal>
  );
}
