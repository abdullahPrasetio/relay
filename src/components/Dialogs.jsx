import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import Modal from './Modal.jsx';

// In-app replacements for window.prompt / confirm / alert, which do not work
// in Electron renderer windows. Exposes async prompt()/confirm()/alert() via
// a context hook so any component can `await` a dialog result.

const DialogContext = createContext(null);

export function useDialogs() {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useDialogs must be used within <DialogProvider>');
  return ctx;
}

export function DialogProvider({ children }) {
  const [dialog, setDialog] = useState(null);
  const resolver = useRef(null);

  const close = useCallback((result) => {
    if (resolver.current) {
      resolver.current(result);
      resolver.current = null;
    }
    setDialog(null);
  }, []);

  const api = useRef({
    prompt(message, defaultValue = '', { title = 'Input', okLabel = 'OK' } = {}) {
      return new Promise((resolve) => {
        resolver.current = resolve;
        setDialog({ kind: 'prompt', message, defaultValue, title, okLabel });
      });
    },
    confirm(message, { title = 'Confirm', okLabel = 'OK', danger = false } = {}) {
      return new Promise((resolve) => {
        resolver.current = resolve;
        setDialog({ kind: 'confirm', message, title, okLabel, danger });
      });
    },
    alert(message, { title = 'Notice' } = {}) {
      return new Promise((resolve) => {
        resolver.current = resolve;
        setDialog({ kind: 'alert', message, title });
      });
    },
  }).current;

  return (
    <DialogContext.Provider value={api}>
      {children}
      {dialog && <DialogHost dialog={dialog} onClose={close} />}
    </DialogContext.Provider>
  );
}

function DialogHost({ dialog, onClose }) {
  const [value, setValue] = useState(dialog.defaultValue ?? '');

  // Prompt: resolve with the text (or null if cancelled).
  if (dialog.kind === 'prompt') {
    const submit = () => onClose(value);
    return (
      <Modal
        title={dialog.title}
        onClose={() => onClose(null)}
        width={420}
        footer={
          <>
            <button className="mini-btn" onClick={() => onClose(null)}>
              Cancel
            </button>
            <button className="send-btn" onClick={submit}>
              {dialog.okLabel}
            </button>
          </>
        }
      >
        <div className="form-row">
          <label>{dialog.message}</label>
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') onClose(null);
            }}
          />
        </div>
      </Modal>
    );
  }

  // Confirm: resolve true/false.
  if (dialog.kind === 'confirm') {
    return (
      <Modal
        title={dialog.title}
        onClose={() => onClose(false)}
        width={420}
        footer={
          <>
            <button className="mini-btn" onClick={() => onClose(false)}>
              Cancel
            </button>
            <button
              className="send-btn"
              style={dialog.danger ? { background: 'var(--red)' } : undefined}
              onClick={() => onClose(true)}
            >
              {dialog.okLabel}
            </button>
          </>
        }
      >
        <p style={{ margin: 0 }}>{dialog.message}</p>
      </Modal>
    );
  }

  // Alert: resolve undefined on close.
  return (
    <Modal
      title={dialog.title}
      onClose={() => onClose()}
      width={420}
      footer={
        <button className="send-btn" onClick={() => onClose()}>
          OK
        </button>
      }
    >
      <p style={{ margin: 0 }}>{dialog.message}</p>
    </Modal>
  );
}
