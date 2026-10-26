import React, { useState } from 'react';
import { newEnvironment } from '../lib/factory.js';
import KeyValueEditor from './KeyValueEditor.jsx';
import Icon from './Icon.jsx';
import { useDialogs } from './Dialogs.jsx';

// Environment selector + a popover editor for the active environment's
// variables. Variables are referenced in requests as {{name}}.
export default function EnvBar({ environments, activeEnvId, onSelect, onChange, globals, onChangeGlobals }) {
  const [editing, setEditing] = useState(false);
  const [editingGlobals, setEditingGlobals] = useState(false);
  const dialogs = useDialogs();
  const active = environments.find((e) => e.id === activeEnvId) || null;

  async function addEnv() {
    const name = await dialogs.prompt('Environment name', 'New Environment', {
      title: 'New Environment',
      okLabel: 'Create',
    });
    if (name == null) return;
    const env = newEnvironment(name || 'New Environment');
    onChange([...environments, env]);
    onSelect(env.id);
    setEditingGlobals(false);
    setEditing(true);
  }

  function updateVars(vars) {
    onChange(
      environments.map((e) => (e.id === activeEnvId ? { ...e, variables: vars } : e))
    );
  }

  async function deleteEnv() {
    if (!active) return;
    const ok = await dialogs.confirm(`Delete environment "${active.name}"?`, {
      title: 'Delete Environment',
      okLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    onChange(environments.filter((e) => e.id !== activeEnvId));
    onSelect(null);
    setEditing(false);
  }

  return (
    <div className="envbar">
      <select
        className="env-select"
        value={activeEnvId || ''}
        onChange={(e) => onSelect(e.target.value || null)}
      >
        <option value="">No Environment</option>
        {environments.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </select>
      <button className="mini-btn" onClick={addEnv} title="New environment">
        + New
      </button>
      {active && (
        <button
          className="mini-btn icon-text"
          onClick={() => {
            setEditingGlobals(false);
            setEditing((v) => !v);
          }}
          title="Edit environment variables"
        >
          <Icon name="gear" size={13} /> Edit
        </button>
      )}
      <button
        className="mini-btn icon-text"
        onClick={() => {
          setEditing(false);
          setEditingGlobals((v) => !v);
        }}
        title="Edit global variables"
      >
        <Icon name="globe" size={13} /> Globals
      </button>

      {editingGlobals && (
        <div className="env-popover">
          <div className="env-popover-head">
            <strong>Global Variables</strong>
            <button className="icon-btn" title="Close" onClick={() => setEditingGlobals(false)}>
              <Icon name="close" size={16} />
            </button>
          </div>
          <KeyValueEditor
            rows={globals || []}
            onChange={onChangeGlobals}
            keyPlaceholder="Variable"
            showType
          />
          <p className="env-hint">
            Globals apply everywhere, below collection and environment variables.
          </p>
        </div>
      )}

      {editing && active && (
        <div className="env-popover">
          <div className="env-popover-head">
            <strong>{active.name}</strong>
            <div>
              <button className="icon-btn" title="Delete environment" onClick={deleteEnv}>
                <Icon name="trash" size={14} />
              </button>
              <button className="icon-btn" title="Close" onClick={() => setEditing(false)}>
                <Icon name="close" size={16} />
              </button>
            </div>
          </div>
          <KeyValueEditor
            rows={active.variables || []}
            onChange={updateVars}
            keyPlaceholder="Variable"
            showType
          />
          <p className="env-hint">
            Use <code>{'{{name}}'}</code> in the URL, params, headers, or body.
          </p>
        </div>
      )}
    </div>
  );
}
