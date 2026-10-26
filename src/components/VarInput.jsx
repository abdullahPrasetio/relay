import React, { useState } from 'react';
import { useVarContext } from './VarContext.jsx';

const VAR_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

// A text input that:
//  - right-click on a selection -> "set as variable"
//  - shows a tooltip preview of {{variables}} it contains (value + scope),
//    flagging undefined ones.
// Behaves like a normal <input> otherwise.
export default function VarInput({ value, onChange, className, placeholder, type = 'text', readOnly }) {
  const { lookup, onSetVariable } = useVarContext();
  const [tip, setTip] = useState(null); // { text }

  const tokens = extractTokens(value);
  const hasVars = tokens.length > 0;
  const anyUnresolved = tokens.some((t) => !lookup(t));

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

  function buildTip() {
    const lines = tokens.map((name) => {
      const hit = lookup(name);
      if (hit) return `${name} = ${hit.value}  (${hit.scope})`;
      return `${name} = (unresolved)`;
    });
    return lines.join('\n');
  }

  return (
    <span className="varinput-wrap">
      <input
        type={type}
        className={`${className || ''} ${hasVars ? (anyUnresolved ? 'has-unresolved-var' : 'has-var') : ''}`}
        value={value ?? ''}
        placeholder={placeholder}
        readOnly={readOnly}
        onChange={(e) => onChange && onChange(e.target.value)}
        onContextMenu={onContextMenu}
        onMouseEnter={() => hasVars && setTip({ text: buildTip() })}
        onMouseLeave={() => setTip(null)}
        title={hasVars ? buildTip() : undefined}
      />
      {tip && <span className="var-tooltip">{tip.text}</span>}
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
