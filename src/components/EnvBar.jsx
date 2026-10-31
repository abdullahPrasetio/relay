import React, { useEffect, useRef, useState } from 'react';
import { newEnvironment } from '../lib/factory.js';
import KeyValueEditor from './KeyValueEditor.jsx';
import Icon from './Icon.jsx';
import { useDialogs } from './Dialogs.jsx';

// Compact environment switcher: one pill in the header opens a menu with the
// environment list plus management actions. Editing still happens in the
// inline popover so the header stays uncluttered (Postman keeps these actions
// in a dropdown for the same reason).
export default function EnvBar({ environments, activeEnvId, onSelect, onChange, globals, onChangeGlobals }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editingGlobals, setEditingGlobals] = useState(false);
  const rootRef = useRef(null);
  const dialogs = useDialogs();
  const active = environments.find((e) => e.id === activeEnvId) || null;

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onPointerDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setMenuOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

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
    <div className="envbar" ref={rootRef}>
      <button
        type="button"
        className="env-trigger"
        onClick={() => setMenuOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title={
          active
            ? `${active.name} — select or manage environments`
            : 'No Environment — select or manage environments'
        }
        data-testid="env-trigger"
      >
        <Icon name="globe" size={13} />
        <span className="env-trigger-label">{active ? active.name : 'No Environment'}</span>
        <Icon name="chevronDown" size={12} />
      </button>

      {menuOpen && (
        <div className="env-menu" role="menu" data-testid="env-menu">
          <button
            type="button"
            role="menuitem"
            className={`env-menu-item ${!activeEnvId ? 'active' : ''}`}
            onClick={() => {
              onSelect(null);
              setMenuOpen(false);
            }}
          >
            <span className="env-menu-name">No Environment</span>
            {!activeEnvId && <Icon name="check" size={13} />}
          </button>
          {environments.map((env) => (
            <button
              key={env.id}
              type="button"
              role="menuitem"
              className={`env-menu-item ${env.id === activeEnvId ? 'active' : ''}`}
              onClick={() => {
                onSelect(env.id);
                setMenuOpen(false);
              }}
            >
              <span className="env-menu-name">{env.name}</span>
              {env.id === activeEnvId && <Icon name="check" size={13} />}
            </button>
          ))}
          <div className="env-menu-sep" />
          <button
            type="button"
            role="menuitem"
            className="env-menu-item"
            onClick={() => {
              setMenuOpen(false);
              addEnv();
            }}
          >
            New environment…
          </button>
          {active && (
            <button
              type="button"
              role="menuitem"
              className="env-menu-item"
              onClick={() => {
                setMenuOpen(false);
                setEditingGlobals(false);
                setEditing(true);
              }}
            >
              Edit variables
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="env-menu-item"
            onClick={() => {
              setMenuOpen(false);
              setEditing(false);
              setEditingGlobals(true);
            }}
          >
            Global variables
          </button>
        </div>
      )}

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
