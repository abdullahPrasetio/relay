import React, { useMemo, useState } from 'react';
import Modal from './Modal.jsx';
import { GENERATORS, generateCode } from '../lib/codegen.js';

// `request` here is already variable-resolved by the caller.
export default function CodeModal({ request, onClose }) {
  const [lang, setLang] = useState('curl');
  const [copied, setCopied] = useState(false);

  const code = useMemo(() => generateCode(lang, request), [lang, request]);

  const [copyErr, setCopyErr] = useState(false);

  async function copy() {
    setCopyErr(false);
    // Try the async Clipboard API first; fall back to execCommand, which
    // works in Electron windows where the Clipboard API may be restricted.
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(code);
        flashCopied();
        return;
      }
    } catch {
      /* fall through to execCommand */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = code;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) flashCopied();
      else setCopyErr(true);
    } catch {
      setCopyErr(true);
    }
  }

  function flashCopied() {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Modal
      title="Code"
      onClose={onClose}
      width={660}
      footer={
        <>
          <button className="mini-btn" onClick={onClose}>
            Close
          </button>
          <button className="send-btn" onClick={copy}>
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </>
      }
    >
      <div className="form-row" style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <label style={{ width: 80 }}>Language</label>
        <select value={lang} onChange={(e) => setLang(e.target.value)}>
          {Object.entries(GENERATORS).map(([id, g]) => (
            <option key={id} value={id}>
              {g.label}
            </option>
          ))}
        </select>
      </div>
      <pre className="code-block">{code}</pre>
      {copyErr && (
        <p className="auth-hint" style={{ color: 'var(--red)' }}>
          Couldn’t copy automatically. Select the text above and copy manually.
        </p>
      )}
      <p className="auth-hint">Variables are resolved using the active environment and collection.</p>
    </Modal>
  );
}
