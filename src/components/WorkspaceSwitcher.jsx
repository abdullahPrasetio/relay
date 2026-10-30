import React, { useState } from 'react';
import { useDialogs } from './Dialogs.jsx';
import Icon from './Icon.jsx';
import WorkspaceMembersModal from './WorkspaceMembersModal.jsx';
import WorkspaceAuditModal from './WorkspaceAuditModal.jsx';
import MonitorsModal from './MonitorsModal.jsx';
import MentionsModal from './MentionsModal.jsx';
import { filesToWorkspace, slugify, workspaceToFiles } from '../lib/gitWorkspace.js';

function hasExportBridge() {
  return typeof window !== 'undefined' && typeof window.api?.exportWorkspace === 'function';
}

function hasImportBridge() {
  return typeof window !== 'undefined' && typeof window.api?.importWorkspaceFiles === 'function';
}

// Fallback for browser-only dev: there is no folder picker, so only the
// manifest is downloaded. Full multi-file export requires the desktop app.
function downloadManifest(files, name) {
  if (typeof document === 'undefined') return false;
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
  const blob = new Blob([files['relay-workspace.json'] || ''], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${slugify(name)}-workspace.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

// Header control to switch between local workspaces and manage them.
const CLOUD_STATE_LABELS = {
  off: 'Not linked',
  synced: 'Synced',
  syncing: 'Syncing…',
  offline: 'Offline',
  conflict: 'Conflict',
};

function cloudStateFor(workspace) {
  if (!workspace?.cloud?.remoteId) return 'off';
  if (workspace.cloud.conflicts?.length) return 'conflict';
  if (workspace.cloud.state === 'offline') return 'offline';
  if (workspace.cloud.state === 'syncing') return 'syncing';
  return 'synced';
}

export default function WorkspaceSwitcher({ store, cloud, onOpenCloud }) {
  const [open, setOpen] = useState(false);
  const [teamWorkspace, setTeamWorkspace] = useState(null);
  const [auditWorkspace, setAuditWorkspace] = useState(null);
  const [monitorsWorkspace, setMonitorsWorkspace] = useState(null);
  const [mentionsWorkspace, setMentionsWorkspace] = useState(null);
  const dialogs = useDialogs();
  const active = store.activeWorkspace;
  const cloudBridge = typeof window !== 'undefined' ? window.api?.cloud : null;

  function openTeam(ws) {
    setOpen(false);
    setTeamWorkspace(ws);
  }

  function openAudit(ws) {
    setOpen(false);
    setAuditWorkspace(ws);
  }

  function openMonitors(ws) {
    setOpen(false);
    setMonitorsWorkspace(ws);
  }

  function openMentions(ws) {
    setOpen(false);
    setMentionsWorkspace(ws);
  }

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

  async function toggleCloud(ws) {
    if (!cloud) return;
    if (!cloud.signedIn) {
      setOpen(false);
      onOpenCloud?.();
      return;
    }
    if (ws.cloud?.remoteId) {
      const ok = await dialogs.confirm(
        `Detach "${ws.name}" from Relay Cloud? Local data stays; the remote copy is not deleted.`,
        { title: 'Detach cloud sync', okLabel: 'Detach' }
      );
      if (!ok) return;
      const res = await cloud.detach(ws.id);
      if (!res?.ok) {
        await dialogs.alert(res?.error?.message || 'Could not detach.', {
          title: 'Cloud sync',
        });
      }
      return;
    }
    setOpen(false);
    const res = await cloud.attach(ws.id);
    if (!res?.ok) {
      await dialogs.alert(res?.error?.message || 'Could not attach this workspace.', {
        title: 'Cloud sync',
      });
    }
  }

  async function exportForGit() {
    setOpen(false);
    const ws = store.activeWorkspace;
    if (!ws) {
      await dialogs.alert('There is no active workspace to export.', { title: 'Export failed' });
      return;
    }

    const files = workspaceToFiles(ws, { generatedAt: new Date().toISOString() });
    const name = slugify(ws.name);

    if (!hasExportBridge()) {
      if (downloadManifest(files, ws.name)) {
        await dialogs.alert(
          'Browser mode can only download the workspace manifest. Use the desktop app to export every collection file.',
          { title: 'Partial export' }
        );
      } else {
        await dialogs.alert('Exporting a workspace requires the desktop app.', {
          title: 'Export unavailable',
        });
      }
      return;
    }

    try {
      const res = await window.api.exportWorkspace(files, name);
      if (res?.ok) {
        await dialogs.alert(`Exported ${res.count} file(s) to:\n${res.dir}`, {
          title: 'Export complete',
        });
      } else if (!res?.canceled) {
        await dialogs.alert(res?.error || 'Export failed.', { title: 'Export failed' });
      }
    } catch (err) {
      await dialogs.alert(err?.message || String(err), { title: 'Export failed' });
    }
  }

  async function importForGit() {
    setOpen(false);
    if (!hasImportBridge()) {
      await dialogs.alert('Importing a workspace requires the desktop app.', {
        title: 'Import unavailable',
      });
      return;
    }

    try {
      const res = await window.api.importWorkspaceFiles();
      if (!res?.ok) {
        if (!res?.canceled) {
          await dialogs.alert(res?.error || 'Import failed.', { title: 'Import failed' });
        }
        return;
      }

      const workspaces = store.workspaces || [];
      const existingWorkspaceIds = workspaces.map((w) => w.id);
      const existingCollectionIds = workspaces.flatMap((w) => [
        ...(w.collections || []).map((c) => c.id),
        ...(w.environments || []).map((e) => e.id),
      ]);

      const { workspace, warnings } = filesToWorkspace(res.files, {
        existingWorkspaceIds,
        existingCollectionIds,
      });
      store.importWorkspace(workspace);

      const detail = warnings.length ? `\n\n${warnings.join('\n')}` : '';
      await dialogs.alert(`Imported "${workspace.name}".${detail}`, { title: 'Import complete' });
    } catch (err) {
      await dialogs.alert(err?.message || String(err), { title: 'Import failed' });
    }
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
                  {cloud && ws.cloud?.remoteId && (
                    <span className={`ws-cloud-badge ${cloudStateFor(ws)}`}>
                      {CLOUD_STATE_LABELS[cloudStateFor(ws)]}
                    </span>
                  )}
                  <span className="ws-count">{ws.collections?.length || 0} coll.</span>
                </button>
                {cloud && (
                  <button
                    className={`icon-btn ws-cloud ${ws.cloud?.remoteId ? 'on' : ''}`}
                    title={
                      !cloud.signedIn
                        ? 'Sign in to sync this workspace'
                        : ws.cloud?.remoteId
                          ? `Cloud: ${CLOUD_STATE_LABELS[cloudStateFor(ws)]} (click to detach)`
                          : 'Sync this workspace to Relay Cloud'
                    }
                    onClick={() => toggleCloud(ws)}
                    data-testid={`ws-cloud-${ws.id}`}
                  >
                    <Icon name={ws.cloud?.remoteId ? 'check' : 'globe'} size={13} />
                  </button>
                )}
                <button className="icon-btn" title="Rename" onClick={() => rename(ws)}>
                  <Icon name="edit" size={13} />
                </button>
                {cloud?.signedIn && ws.cloud?.remoteId && (
                  <>
                    <button
                      className="icon-btn ws-team"
                      title="Members and invites"
                      aria-label={`Members and invites for ${ws.name}`}
                      onClick={() => openTeam(ws)}
                      data-testid={`ws-members-${ws.id}`}
                    >
                      <Icon name="workspace" size={13} />
                    </button>
                    <button
                      className="icon-btn ws-team"
                      title="Audit log"
                      aria-label={`Audit log for ${ws.name}`}
                      onClick={() => openAudit(ws)}
                      data-testid={`ws-audit-${ws.id}`}
                    >
                      <Icon name="clock" size={13} />
                    </button>
                    <button
                      className="icon-btn ws-team"
                      title="Mentions"
                      aria-label={`Comments mentioning you in ${ws.name}`}
                      onClick={() => openMentions(ws)}
                      data-testid={`ws-mentions-${ws.id}`}
                    >
                      <Icon name="comment" size={13} />
                    </button>
                    <button
                      className="icon-btn ws-team"
                      title="Scheduled monitors"
                      aria-label={`Scheduled monitors for ${ws.name}`}
                      onClick={() => openMonitors(ws)}
                      data-testid={`ws-monitors-${ws.id}`}
                    >
                      <Icon name="monitor" size={13} />
                    </button>
                  </>
                )}
                <button className="icon-btn" title="Delete" onClick={() => remove(ws)}>
                  <Icon name="close" size={13} />
                </button>
              </div>
            ))}
            <button className="ws-create" onClick={create}>
              + New Workspace
            </button>
            <button className="ws-create" onClick={exportForGit}>
              Export for Git…
            </button>
            <button className="ws-create" onClick={importForGit}>
              Import workspace…
            </button>
          </div>
        </>
      )}
      {teamWorkspace && (
        <WorkspaceMembersModal
          workspace={teamWorkspace}
          currentUserId={cloud?.user?.id || null}
          cloud={cloudBridge}
          reencryptSecrets={cloud?.reencryptSecrets || null}
          onClose={() => setTeamWorkspace(null)}
        />
      )}
      {auditWorkspace && (
        <WorkspaceAuditModal
          workspace={auditWorkspace}
          cloud={cloudBridge}
          onClose={() => setAuditWorkspace(null)}
        />
      )}
      {monitorsWorkspace && (
        <MonitorsModal
          workspace={monitorsWorkspace}
          currentUserId={cloud?.user?.id || null}
          cloud={cloudBridge}
          onClose={() => setMonitorsWorkspace(null)}
        />
      )}
      {mentionsWorkspace && (
        <MentionsModal
          workspace={mentionsWorkspace}
          cloud={cloudBridge}
          onClose={() => setMentionsWorkspace(null)}
        />
      )}
    </div>
  );
}
