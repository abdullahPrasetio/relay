import React, { useEffect, useRef, useState } from 'react';
import { newCollection, newEnvironment } from '../lib/factory.js';
import '../styles/history.css';
import {
  renameNode,
  renameCollection,
  deleteNode,
  addFolder,
  addRequest,
  duplicateNode,
  moveNode,
  moveNodeTo,
  moveNodeBefore,
} from '../lib/collectionTree.js';
import { toPostmanCollection } from '../lib/postmanFormat.js';
import { collectionToHtml, suggestDocsName } from '../lib/apiDocs.js';
import { importAny } from '../lib/import/index.js';
import { toPostmanEnvironment, fromPostmanEnvironment } from '../lib/environmentFormat.js';
import TreeNode from './TreeNode.jsx';
import Icon from './Icon.jsx';
import { useDialogs } from './Dialogs.jsx';

export default function Sidebar({
  collections,
  onChangeCollections,
  environments,
  onChangeEnvironments,
  activeEnvId,
  onSelectEnv,
  history,
  onClearHistory,
  historyLimit = 100,
  onChangeHistoryLimit,
  onRemoveHistory,
  activeRequestId,
  onOpenRequest,
  onEditCollectionVars,
  onOpenCollection,
  onEditEnvironment,
  onRun,
  view = 'collections',
  query: externalQuery,
  onQueryChange,
}) {
  const [collapsed, setCollapsed] = useState({});
  const [localQuery, setLocalQuery] = useState('');
  // The header's global search drives filtering when provided; otherwise the
  // sidebar keeps its own local search box.
  const query = externalQuery != null ? externalQuery : localQuery;
  const setQuery = onQueryChange || setLocalQuery;
  const dragRef = useRef(null); // { collectionId, nodeId }
  const fileInputRef = useRef(null);
  const dialogs = useDialogs();
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyMethod, setHistoryMethod] = useState('all');
  const [historyStatus, setHistoryStatus] = useState('all');

  const dnd = {
    onDragStart(collectionId, nodeId) {
      dragRef.current = { collectionId, nodeId };
    },
    onDragEnd() {
      dragRef.current = null;
    },
    onDrop(targetCollectionId, targetFolderId) {
      const src = dragRef.current;
      dragRef.current = null;
      if (!src || src.nodeId === targetFolderId) return;
      onChangeCollections(
        moveNodeTo(collections, src.nodeId, targetCollectionId, targetFolderId)
      );
    },
    // Drop onto a request row: reorder so the dragged node sits before it.
    onDropBefore(targetNodeId) {
      const src = dragRef.current;
      dragRef.current = null;
      if (!src || src.nodeId === targetNodeId) return;
      onChangeCollections(moveNodeBefore(collections, src.nodeId, targetNodeId));
    },
  };

  function toggleCollapse(id) {
    setCollapsed((c) => ({ ...c, [id]: !c[id] }));
  }

  async function addCollection() {
    const name = await dialogs.prompt('Collection name', 'New Collection', {
      title: 'New Collection',
      okLabel: 'Create',
    });
    if (name == null) return;
    onChangeCollections([
      ...collections,
      { ...newCollection(name || 'New Collection') },
    ]);
  }

  async function deleteCollection(collectionId, name) {
    const ok = await dialogs.confirm(
      `Delete collection "${name}"? This removes all its requests.`,
      { title: 'Delete Collection', okLabel: 'Delete', danger: true }
    );
    if (!ok) return;
    onChangeCollections(collections.filter((c) => c.id !== collectionId));
  }

  function exportCollection(collection) {
    const data = JSON.stringify(toPostmanCollection(collection), null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${collection.name.replace(/[^\w.-]+/g, '_')}.postman_collection.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Static HTML API docs. Uses the native save dialog when the Electron
  // bridge is available and a Blob download in the browser.
  async function exportDocs(collection) {
    const html = collectionToHtml(collection);
    const suggestedName = suggestDocsName(collection);
    const bridge = typeof window !== 'undefined' ? window.api : null;
    if (bridge?.saveResponse) {
      try {
        const result = await bridge.saveResponse({ suggestedName, text: html });
        if (result?.saved === false && result.error) {
          dialogs.alert(result.error, { title: 'Export Docs' });
        }
      } catch (err) {
        dialogs.alert(err.message, { title: 'Export Docs' });
      }
      return;
    }
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedName;
    a.click();
    URL.revokeObjectURL(url);
  }

  function onImportClick() {
    fileInputRef.current?.click();
  }

  // One button for every supported format: Postman, OpenAPI/Swagger, HAR,
  // cURL and Insomnia. Detection happens on the file text, so the picker does
  // not need a format selector.
  function onFileChosen(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const result = importAny(String(reader.result || ''));
        if (result.collections.length) {
          onChangeCollections([...collections, ...result.collections]);
        }
        if (result.environments.length) {
          onChangeEnvironments([...environments, ...result.environments]);
        }
      } catch (err) {
        dialogs.alert('Failed to import: ' + err.message, { title: 'Import Error' });
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  // Actions passed down to tree nodes.
  const actions = {
    async rename(collectionId, nodeId, currentName) {
      const name = await dialogs.prompt('New name', currentName || '', {
        title: 'Rename',
        okLabel: 'Rename',
      });
      if (name == null) return;
      onChangeCollections(renameNode(collections, collectionId, nodeId, name));
    },
    async remove(collectionId, nodeId, name) {
      const ok = await dialogs.confirm(`Delete "${name}"?`, {
        title: 'Delete',
        okLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      onChangeCollections(deleteNode(collections, collectionId, nodeId));
    },
    async addFolder(collectionId, parentFolderId) {
      const name = await dialogs.prompt('Folder name', 'New Folder', {
        title: 'New Folder',
        okLabel: 'Create',
      });
      if (name == null) return;
      onChangeCollections(addFolder(collections, collectionId, parentFolderId, name || 'New Folder'));
    },
    addRequest(collectionId, parentFolderId) {
      const { collections: next, node } = addRequest(collections, collectionId, parentFolderId);
      onChangeCollections(next);
      onOpenRequest(node);
    },
    duplicate(collectionId, nodeId) {
      onChangeCollections(duplicateNode(collections, collectionId, nodeId));
    },
    move(collectionId, nodeId, delta) {
      onChangeCollections(moveNode(collections, collectionId, nodeId, delta));
    },
    run(collectionId, folderId) {
      onRun(collectionId, folderId);
    },
  };

  const historyMethods = [...new Set((history || []).map((h) => h.method).filter(Boolean))].sort();
  const filteredHistory = filterHistory(history || [], {
    query: historyQuery,
    method: historyMethod,
    status: historyStatus,
  });
  const historyGroups = groupHistoryByDay(filteredHistory);

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">
          {view === 'collections' && 'Collections'}
          {view === 'environments' && 'Environments'}
          {view === 'history' && 'History'}
        </span>
      </div>

      {view === 'environments' && (
        <EnvironmentsPanel
          environments={environments}
          activeEnvId={activeEnvId}
          onSelectEnv={onSelectEnv}
          onChangeEnvironments={onChangeEnvironments}
          onEditEnvironment={onEditEnvironment}
          dialogs={dialogs}
        />
      )}

      {view === 'collections' && (
        <div className="sidebar-content">
          <div className="sidebar-actions">
            <button className="mini-btn" onClick={addCollection}>
              + New
            </button>
            <button
              className="mini-btn"
              onClick={onImportClick}
              title="Import Postman, OpenAPI/Swagger, HAR, cURL or Insomnia"
            >
              Import
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.har,.yaml,.yml,.sh,.txt,application/json"
              style={{ display: 'none' }}
              onChange={onFileChosen}
            />
          </div>

          <input
            className="tree-search"
            placeholder="Search requests…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          {collections.length === 0 && (
            <div className="sidebar-empty">No collections yet. Click “+ New”.</div>
          )}

          {collections.map((c) => {
            const isCollapsed = collapsed[c.id];
            const filteredItems = filterTree(c.items, query);
            if (query && filteredItems.length === 0) return null;
            return (
              <div key={c.id} className="collection">
                <div
                  className="tree-row collection-row"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    dnd.onDrop(c.id, null);
                  }}>
                  <button className="twisty" onClick={() => toggleCollapse(c.id)}>
                    <Icon name={isCollapsed ? 'chevronRight' : 'chevronDown'} size={14} />
                  </button>
                  <span className="tree-icon"><Icon name="collection" size={15} /></span>
                  <span
                    className="tree-label collection-name"
                    title="Open collection settings"
                    onClick={() => onOpenCollection(c.id)}
                  >
                    {c.name}
                  </span>
                  <CollectionKebab
                    collection={c}
                    actions={actions}
                    onExport={() => exportCollection(c)}
                    onExportDocs={() => exportDocs(c)}
                    onDelete={() => deleteCollection(c.id, c.name)}
                    onRename={async () => {
                      const name = await dialogs.prompt('Collection name', c.name, {
                        title: 'Rename Collection',
                        okLabel: 'Rename',
                      });
                      if (name == null) return;
                      onChangeCollections(renameCollection(collections, c.id, name));
                    }}
                    onEditCollection={() => onOpenCollection(c.id)}
                    onRun={() => onRun(c.id, null)}
                  />
                </div>
                {!isCollapsed && (
                  <div className="tree-children">
                    {filteredItems.length === 0 && (
                      <div className="tree-empty" style={{ paddingLeft: 22 }}>
                        {query ? 'No matches.' : 'Empty. Use the ⋯ menu to add a request or folder.'}
                      </div>
                    )}
                    {filteredItems.map((node) => (
                      <TreeNode
                        key={node.id}
                        node={node}
                        depth={1}
                        collectionId={c.id}
                        activeRequestId={activeRequestId}
                        onOpenRequest={onOpenRequest}
                        actions={actions}
                        dnd={dnd}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {view === 'history' && (
        <div className="sidebar-content history-view">
          <div className="history-toolbar">
            <input
              className="tree-search"
              placeholder="Search history…"
              value={historyQuery}
              onChange={(e) => setHistoryQuery(e.target.value)}
            />
            <div className="history-filters">
              <select
                className="history-filter"
                aria-label="Filter by method"
                value={historyMethod}
                onChange={(e) => setHistoryMethod(e.target.value)}
              >
                <option value="all">All methods</option>
                {historyMethods.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <select
                className="history-filter"
                aria-label="Filter by status"
                value={historyStatus}
                onChange={(e) => setHistoryStatus(e.target.value)}
              >
                <option value="all">All statuses</option>
                <option value="2xx">2xx</option>
                <option value="3xx">3xx</option>
                <option value="4xx">4xx</option>
                <option value="5xx">5xx</option>
                <option value="errors">Errors</option>
              </select>
            </div>
            <div className="history-retention">
              <label htmlFor="history-limit">Keep</label>
              <HistoryLimitInput value={historyLimit} onChange={onChangeHistoryLimit} />
              <span>entries</span>
              <button
                className="mini-btn history-clear"
                onClick={onClearHistory}
                disabled={history.length === 0}
              >
                Clear
              </button>
            </div>
          </div>

          {history.length === 0 && <div className="sidebar-empty">No history yet.</div>}
          {history.length > 0 && filteredHistory.length === 0 && (
            <div className="sidebar-empty">No history entries match these filters.</div>
          )}

          {historyGroups.map((group) => (
            <div key={group.label} className="history-group">
              <div className="history-date">{group.label}</div>
              {group.entries.map((h) => (
                <div
                  key={h.id}
                  className="history-item"
                  onClick={() => h.snapshot && onOpenRequest(h.snapshot)}
                >
                  <span className={`method-tag method-${h.method}`}>{h.method}</span>
                  <span className="history-url" title={h.url}>
                    {h.url}
                  </span>
                  {h.status != null ? (
                    <span className={`history-status s${Math.floor(h.status / 100)}`}>
                      {h.status}
                    </span>
                  ) : (
                    !h.ok && <span className="history-status s5">error</span>
                  )}
                  <button
                    className="icon-btn history-delete"
                    title="Delete from history"
                    aria-label="Delete history entry"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemoveHistory?.(h.id);
                    }}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

function HistoryLimitInput({ value, onChange }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  function commit() {
    const n = Number(draft);
    if (Number.isFinite(n) && n >= 10 && n <= 1000) {
      onChange?.(Math.trunc(n));
    } else {
      setDraft(String(value));
    }
  }

  return (
    <input
      id="history-limit"
      className="history-limit-input"
      type="number"
      min={10}
      max={1000}
      aria-label="History retention limit"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
    />
  );
}

// Search (method/url), method and status-bucket filters for the history view.
function filterHistory(entries, { query, method, status }) {
  const q = String(query || '').trim().toLowerCase();
  return (entries || []).filter((h) => {
    if (method && method !== 'all' && h.method !== method) return false;
    if (status && status !== 'all') {
      if (status === 'errors') {
        if (h.ok) return false;
      } else {
        const bucket = h.status != null ? `${Math.floor(h.status / 100)}xx` : '';
        if (bucket !== status) return false;
      }
    }
    if (!q) return true;
    return `${h.method || ''} ${h.url || ''}`.toLowerCase().includes(q);
  });
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function dayKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function historyDayLabel(at) {
  const d = at ? new Date(at) : null;
  if (!d || Number.isNaN(d.getTime())) return 'Unknown';
  const now = new Date();
  const key = dayKey(d);
  if (key === dayKey(now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (key === dayKey(yesterday)) return 'Yesterday';
  return key;
}

// Group newest-first entries by calendar day, preserving their order.
function groupHistoryByDay(entries) {
  const groups = new Map();
  for (const entry of entries || []) {
    const label = historyDayLabel(entry.at);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(entry);
  }
  return [...groups].map(([label, groupEntries]) => ({ label, entries: groupEntries }));
}

// Filter a tree by a case-insensitive query against request name/url and
// folder name. Folders are kept if they contain any matching descendant.
function filterTree(items, query) {
  if (!query || !query.trim()) return items;
  const q = query.toLowerCase();
  const walk = (list) => {
    const out = [];
    for (const node of list) {
      if (node.type === 'folder') {
        const children = walk(node.items);
        const nameMatch = (node.name || '').toLowerCase().includes(q);
        if (children.length > 0 || nameMatch) {
          out.push({ ...node, items: children.length > 0 ? children : node.items });
        }
      } else {
        const hay = `${node.name || ''} ${node.url || ''} ${node.method || ''}`.toLowerCase();
        if (hay.includes(q)) out.push(node);
      }
    }
    return out;
  };
  return walk(items);
}

// Environments list panel (shown when the rail selects "Environments").
function EnvironmentsPanel({ environments, activeEnvId, onSelectEnv, onChangeEnvironments, onEditEnvironment, dialogs }) {
  const envFileRef = useRef(null);

  async function addEnv() {
    const name = await dialogs.prompt('Environment name', 'New Environment', {
      title: 'New Environment',
      okLabel: 'Create',
    });
    if (name == null) return;
    const env = newEnvironment(name || 'New Environment');
    onChangeEnvironments([...environments, env]);
    onSelectEnv(env.id);
    onEditEnvironment(env.id);
  }

  function exportEnv(env) {
    const data = JSON.stringify(toPostmanEnvironment(env), null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${env.name.replace(/[^\w.-]+/g, '_')}.postman_environment.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function onImportEnv(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = JSON.parse(reader.result);
        const env = fromPostmanEnvironment(json);
        onChangeEnvironments([...environments, env]);
      } catch (err) {
        dialogs.alert('Failed to import environment: ' + err.message, { title: 'Import Error' });
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  async function removeEnv(id, name) {
    const ok = await dialogs.confirm(`Delete environment "${name}"?`, {
      title: 'Delete Environment',
      okLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    onChangeEnvironments(environments.filter((e) => e.id !== id));
    if (activeEnvId === id) onSelectEnv(null);
  }

  return (
    <div className="sidebar-content">
      <div className="sidebar-actions">
        <button className="mini-btn" onClick={addEnv}>
          + New
        </button>
        <button className="mini-btn" onClick={() => envFileRef.current?.click()} title="Import Postman environment">
          Import
        </button>
        <input
          ref={envFileRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={onImportEnv}
        />
      </div>
      {environments.length === 0 && (
        <div className="sidebar-empty">No environments yet. Click “+ New”.</div>
      )}
      {environments.map((e) => (
        <div
          key={e.id}
          className={`tree-row request-row ${e.id === activeEnvId ? 'active' : ''}`}
          onClick={() => onSelectEnv(e.id)}
        >
          <span className="tree-icon"><Icon name="globe" size={15} /></span>
          <span className="tree-label">{e.name}</span>
          {e.id === activeEnvId && <span className="env-active-dot" title="Active" />}
          <span className="kebab-wrap" onClick={(ev) => ev.stopPropagation()}>
            <button
              className="icon-btn"
              title="Edit variables"
              onClick={() => {
                onSelectEnv(e.id);
                onEditEnvironment(e.id);
              }}
            >
              <Icon name="gear" size={14} />
            </button>
            <button className="icon-btn" title="Export environment" onClick={() => exportEnv(e)}>
              <Icon name="upload" size={14} />
            </button>
            <button className="icon-btn" title="Delete" onClick={() => removeEnv(e.id, e.name)}>
              <Icon name="close" size={14} />
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}

function CollectionKebab({ collection, actions, onExport, onExportDocs, onDelete, onRename, onEditCollection, onRun }) {
  const [open, setOpen] = useState(false);
  const items = [
    { label: 'Run Collection', onClick: onRun },
    { label: 'Edit Collection', onClick: onEditCollection },
    { label: 'Add Request', onClick: () => actions.addRequest(collection.id, null) },
    { label: 'Add Folder', onClick: () => actions.addFolder(collection.id, null) },
    { label: 'Rename', onClick: onRename },
    { label: 'Export (Postman v2.1)', onClick: onExport },
    { label: 'Export docs (HTML)', onClick: onExportDocs },
    { label: 'Delete', danger: true, onClick: onDelete },
  ];
  return (
    <span className="kebab-wrap" onClick={(e) => e.stopPropagation()}>
      <button className="kebab-btn" title="Collection actions" onClick={() => setOpen((v) => !v)}>
        <Icon name="kebab" size={16} />
      </button>
      {open && (
        <>
          <div className="kebab-backdrop" onClick={() => setOpen(false)} />
          <div className="kebab-menu">
            {items.map((it, i) => (
              <button
                key={i}
                className={`kebab-item ${it.danger ? 'danger' : ''}`}
                onClick={() => {
                  setOpen(false);
                  it.onClick();
                }}
              >
                {it.label}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}
