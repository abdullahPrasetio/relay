import React, { useState } from 'react';
import { newKeyValue } from '../lib/factory.js';
import VarInput from './VarInput.jsx';
import Icon from './Icon.jsx';

// Reusable editable table of key/value rows (used for query params and headers).
// An empty trailing row is always shown so there is somewhere to type.
//
// `showType` adds a Default/Secret switch (used by variable editors). Secret
// rows render their value as a password field with a Show/Hide toggle; the
// stored value is still plain in the row (the encryption layer owns secretEnc).
export default function KeyValueEditor({
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  showType = false,
}) {
  const display = [...rows, newKeyValue()];
  const [revealed, setRevealed] = useState(() => new Set());

  function update(index, patch) {
    const next = [...rows];
    if (index === rows.length) {
      // Editing the phantom trailing row -> materialize it.
      next.push({ ...newKeyValue(), ...patch });
    } else {
      next[index] = { ...next[index], ...patch };
    }
    onChange(next);
  }

  function remove(index) {
    const next = rows.filter((_, i) => i !== index);
    onChange(next);
  }

  function toggleReveal(index) {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function valueCell(row, i) {
    if (showType && row.type === 'secret') {
      const isRevealed = revealed.has(i);
      const hasStoredSecret = Boolean(row.secretEnc) && !row.value;
      return (
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <span className="varinput-wrap">
            <input
              type={isRevealed ? 'text' : 'password'}
              value={row.value ?? ''}
              placeholder={hasStoredSecret ? '•••• (secret)' : valuePlaceholder || 'Secret value'}
              onChange={(e) => update(i, { value: e.target.value })}
            />
          </span>
          <button
            type="button"
            className="mini-btn"
            title={isRevealed ? 'Hide value' : 'Show value'}
            onClick={() => toggleReveal(i)}
          >
            {isRevealed ? 'Hide' : 'Show'}
          </button>
        </div>
      );
    }
    return (
      <VarInput
        value={row.value}
        placeholder={valuePlaceholder || 'Value'}
        onChange={(v) => update(i, { value: v })}
      />
    );
  }

  return (
    <table className="kv">
      <thead>
        <tr>
          <th className="kv-check"></th>
          <th>{keyPlaceholder || 'Key'}</th>
          <th>{valuePlaceholder || 'Value'}</th>
          {showType && <th className="kv-type">Type</th>}
          <th className="kv-actions"></th>
        </tr>
      </thead>
      <tbody>
        {display.map((row, i) => {
          const isPhantom = i === rows.length;
          const type = row.type === 'secret' ? 'secret' : 'default';
          return (
            <tr key={i} className={isPhantom ? 'phantom' : ''}>
              <td className="kv-check">
                <input
                  type="checkbox"
                  checked={row.enabled !== false}
                  disabled={isPhantom}
                  onChange={(e) => update(i, { enabled: e.target.checked })}
                />
              </td>
              <td>
                <VarInput
                  value={row.key}
                  placeholder={keyPlaceholder || 'Key'}
                  onChange={(v) => update(i, { key: v })}
                />
              </td>
              <td>{valueCell(row, i)}</td>
              {showType && (
                <td className="kv-type">
                  <select
                    value={type}
                    disabled={isPhantom}
                    onChange={(e) => update(i, { type: e.target.value })}
                  >
                    <option value="default">Default</option>
                    <option value="secret">Secret</option>
                  </select>
                </td>
              )}
              <td className="kv-actions">
                {!isPhantom && (
                  <button className="icon-btn" title="Remove" onClick={() => remove(i)}>
                    <Icon name="close" size={14} />
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
