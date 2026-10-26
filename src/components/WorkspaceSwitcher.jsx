import React, { useState } from 'react';
import { useDialogs } from './Dialogs.jsx';
import Icon from './Icon.jsx';

// Header control to switch between local workspaces and manage them.
export default function WorkspaceSwitcher({ store }) {
  const [open, setOpen] = useState(false);
  const dialogs = useDialogs();
  const active = store.activeWorkspace;

  async function create() {
    setOpen(false);
    const name = await dialogs.prompt('Workspace name', 'New Workspace', {
      title: 'New Workspace',
      okLabel: 'Create',
    });
    if (name == null) return;
    store.createWorkspace(name || 'New Workspace');
  }

  async function rename(ws) {
    setOpen(false);
    const name = await dialogs.prompt('Workspace name', ws.name, {
      title: 'Rename Workspace',
      okLabel: 'Rename',
    });
    if (name == null) return;
    store.renameWorkspace(ws.id, name || ws.name);
  }

  async function remove(ws) {
    setOpen(false);
    if (store.workspaces.length <= 1) {
      await dialogs.alert('You must keep at least one workspace.', { title: 'Cannot delete' });
      return;
    }
    const ok = await dialogs.confirm(
      `Delete workspace "${ws.name}"? Its collections, environments, and history will be removed.`,
      { title: 'Delete Workspace', okLabel: 'Delete', danger: true }
    );
    if (!ok) return;
    store.deleteWorkspace(ws.id);
  }

  return (
    <div className="ws-switcher">
      <button className="ws-button" onClick={() => setOpen((v) => !v)} title="Switch workspace">
        <Icon name="workspace" size={14} className="ws-icon" />
        <span className="ws-name">{active?.name || 'Workspace'}</span>
        <Icon name="chevronDown" size={13} className="ws-caret" />
      </button>
      {open && (
        <>
          <div className="kebab-backdrop" onClick={() => setOpen(false)} />
          <div className="ws-menu">
            <div className="ws-menu-title">Workspaces</div>
            {store.workspaces.map((ws) => (
              <div key={ws.id} className={`ws-item ${ws.id === store.activeWorkspaceId ? 'active' : ''}`}>
                <button
                  className="ws-item-name"
                  onClick={() => {
                    store.switchWorkspace(ws.id);
                    setOpen(false);
                  }}
                >
                  <span className={`ws-dot ${ws.id === store.activeWorkspaceId ? 'on' : ''}`} />
                  {ws.name}
                  <span className="ws-count">{ws.collections?.length || 0} coll.</span>
                </button>
                <button className="icon-btn" title="Rename" onClick={() => rename(ws)}>
                  <Icon name="edit" size={13} />
                </button>
                <button className="icon-btn" title="Delete" onClick={() => remove(ws)}>
                  <Icon name="close" size={13} />
                </button>
              </div>
            ))}
            <button className="ws-create" onClick={create}>
              + New Workspace
            </button>
          </div>
        </>
      )}
    </div>
  );
}
