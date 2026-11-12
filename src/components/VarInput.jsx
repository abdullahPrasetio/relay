import React, { useState } from 'react';
import { useVarContext } from './VarContext.jsx';

const VAR_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

function scopeShort(scope) {
  if (scope === 'environment') return 'E';
  if (scope === 'collection') return 'C';
  if (scope === 'globals') return 'G';
  return '•';
}

// A text input that:
//  - right-click on a selection -> "set as variable"
//  - shows a hover card for {{variables}} with their value/scope and an Edit
//    action, so variables can be updated from URL, params, headers and auth.
// Behaves like a normal <input> otherwise.
export default function VarInput({ value, onChange, className, placeholder, type = 'text', readOnly }) {
  const { lookup, onSetVariable, onEditVariable } = useVarContext();
  const [tipOpen, setTipOpen] = useState(false);
  const [selectionText, setSelectionText] = useState('');

  const tokens = extractTokens(value);
  const hasVars = tokens.length > 0;
  const anyUnresolved = tokens.some((t) => !lookup(t));

  function readSelection(e) {
    const el = e.target;
    if (typeof el.selectionStart !== 'number' || el.selectionEnd <= el.selectionStart) {
      setSelectionText('');
      return;
    }
    setSelectionText(String(value ?? '').slice(el.selectionStart, el.selectionEnd).trim());
  }

  function onContextMenu(e) {
    const el = e.target;
    const sel =
      typeof el.selectionStart === 'number'
        ? String(value ?? '').substring(el.selectionStart, el.selectionEnd)
        : '';
    if (sel && sel.trim()) {
      e.preventDefault();
      onSetVariable(sel);
    }
  }

  return (
    <span
      className="varinput-wrap"
      onMouseEnter={() => hasVars && setTipOpen(true)}
      onMouseLeave={() => setTipOpen(false)}
    >
      <input
        type={type}
        className={`${className || ''} ${hasVars ? (anyUnresolved ? 'has-unresolved-var' : 'has-var') : ''}`}
        value={value ?? ''}
        placeholder={placeholder}
        readOnly={readOnly}
        onChange={(e) => onChange && onChange(e.target.value)}
        onContextMenu={onContextMenu}
        onSelect={readSelection}
        onKeyUp={readSelection}
        onMouseUp={readSelection}
        onBlur={() => setSelectionText('')}
        title={hasVars ? tokens.map((name) => `${name} = ${lookup(name)?.value ?? '(unresolved)'}`).join('\n') : undefined}
      />
      {selectionText && (
        <button
          type="button"
          className="var-selection-action"
          data-testid="var-set-variable"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onSetVariable(selectionText);
            setSelectionText('');
          }}
        >
          Set as variable
        </button>
      )}
      {tipOpen && hasVars && (
        <span className="var-tooltip var-tip-card" role="tooltip">
          {tokens.map((name) => {
            const hit = lookup(name);
            return (
              <span key={name} className="var-tip-item">
                <span className="var-tip-name">{`{{${name}}}`}</span>
                <span className="var-tip-value">
                  {hit ? hit.value : 'variable is not defined'}
                </span>
                <span className="var-tip-meta">
                  <span>
                    {hit ? `${scopeShort(hit.scope)}  ${hit.scope}` : 'unresolved'}
                  </span>
                  <button
                    type="button"
                    className="var-tip-edit"
                    data-testid={`var-edit-${name}`}
                    onClick={() => {
                      setTipOpen(false);
                      onEditVariable(name);
                    }}
                  >
                    {hit ? 'Edit' : 'Set'}
                  </button>
                </span>
              </span>
            );
          })}
        </span>
      )}
    </span>
  );
}

function extractTokens(str) {
  if (typeof str !== 'string' || !str) return [];
  const names = [];
  let m;
  VAR_RE.lastIndex = 0;
  while ((m = VAR_RE.exec(str)) !== null) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}
