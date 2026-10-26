import React from 'react';
import { newKeyValue } from '../lib/factory.js';
import VarInput from './VarInput.jsx';
import Icon from './Icon.jsx';

// Reusable editable table of key/value rows (used for query params and headers).
// An empty trailing row is always shown so there is somewhere to type.
export default function KeyValueEditor({ rows, onChange, keyPlaceholder, valuePlaceholder }) {
  const display = [...rows, newKeyValue()];

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

  return (
    <table className="kv">
      <thead>
        <tr>
          <th className="kv-check"></th>
          <th>{keyPlaceholder || 'Key'}</th>
          <th>{valuePlaceholder || 'Value'}</th>
          <th className="kv-actions"></th>
        </tr>
      </thead>
      <tbody>
        {display.map((row, i) => {
          const isPhantom = i === rows.length;
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
              <td>
                <VarInput
                  value={row.value}
                  placeholder={valuePlaceholder || 'Value'}
                  onChange={(v) => update(i, { value: v })}
                />
              </td>
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
