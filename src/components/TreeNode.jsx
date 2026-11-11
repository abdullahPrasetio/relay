import React, { useState } from 'react';
import Icon from './Icon.jsx';
import ContextMenu from './ContextMenu.jsx';

// Renders one node (folder or request) and its children recursively.
// Folders expand/collapse; each row has a kebab menu and a right-click menu
// with the same actions. Saved examples appear as read-only children of their
// request.
export default function TreeNode({
  node,
  depth,
  collectionId,
  activeRequestId,
  onOpenRequest,
  actions,
  dnd,
}) {
  const [open, setOpen] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [showExamples, setShowExamples] = useState(true);

  const indent = { paddingLeft: 8 + depth * 14 };

  const dragProps = {
    draggable: true,
    onDragStart: (e) => {
      e.stopPropagation();
      dnd.onDragStart(collectionId, node.id);
      e.dataTransfer.effectAllowed = 'move';
    },
    onDragEnd: () => dnd.onDragEnd(),
  };

  const openContextMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  if (node.type === 'folder') {
    const items = [
      { label: 'Run Folder', onClick: () => actions.run(collectionId, node.id) },
      { label: 'Add Request', onClick: () => actions.addRequest(collectionId, node.id) },
      { label: 'Add Folder', onClick: () => actions.addFolder(collectionId, node.id) },
      { label: 'Rename', onClick: () => actions.rename(collectionId, node.id, node.name) },
      { label: 'Duplicate', onClick: () => actions.duplicate(collectionId, node.id) },
      { label: 'Move Up', onClick: () => actions.move(collectionId, node.id, -1) },
      { label: 'Move Down', onClick: () => actions.move(collectionId, node.id, 1) },
      { label: 'Delete', danger: true, onClick: () => actions.remove(collectionId, node.id, node.name) },
    ];
    return (
      <div className="tree-folder">
        <div
          className={`tree-row folder-row ${dragOver ? 'drop-target' : ''}`}
          style={indent}
          {...dragProps}
          onContextMenu={openContextMenu}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragOver(false);
            dnd.onDrop(collectionId, node.id);
          }}
        >
          <button className="twisty" onClick={() => setOpen((v) => !v)}>
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
          </button>
          <span className="tree-icon"><Icon name="folder" size={15} /></span>
          <span className="tree-label" onClick={() => setOpen((v) => !v)}>
            {node.name}
          </span>
          <Kebab open={menuOpen} setOpen={setMenuOpen} items={items} />
        </div>
        {open && (
          <div className="tree-children">
            {node.items.length === 0 && (
              <div className="tree-empty" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
                Empty folder
              </div>
            )}
            {node.items.map((child) => (
              <TreeNode
                key={child.id}
                node={child}
                depth={depth + 1}
                collectionId={collectionId}
                activeRequestId={activeRequestId}
                onOpenRequest={onOpenRequest}
                actions={actions}
                dnd={dnd}
              />
            ))}
          </div>
        )}
        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            items={items}
            onClose={() => setContextMenu(null)}
          />
        )}
      </div>
    );
  }

  // request node
  const items = [
    { label: 'Open', onClick: () => onOpenRequest(node) },
    { label: 'Rename', onClick: () => actions.rename(collectionId, node.id, node.name) },
    { label: 'Duplicate', onClick: () => actions.duplicate(collectionId, node.id) },
    { label: 'Move Up', onClick: () => actions.move(collectionId, node.id, -1) },
    { label: 'Move Down', onClick: () => actions.move(collectionId, node.id, 1) },
    { label: 'Delete', danger: true, onClick: () => actions.remove(collectionId, node.id, node.name) },
  ];
  const examples = Array.isArray(node.examples) ? node.examples : [];

  return (
    <>
      <div
        className={`tree-row request-row ${node.id === activeRequestId ? 'active' : ''} ${
          dragOver ? 'drop-before' : ''
        }`}
        style={indent}
        onClick={() => onOpenRequest(node)}
        {...dragProps}
        onContextMenu={openContextMenu}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragOver(false);
          dnd.onDropBefore(node.id);
        }}
      >
        {examples.length > 0 ? (
          <button
            className="twisty"
            title={showExamples ? 'Hide examples' : 'Show examples'}
            onClick={(e) => {
              e.stopPropagation();
              setShowExamples((v) => !v);
            }}
          >
            <Icon name={showExamples ? 'chevronDown' : 'chevronRight'} size={14} />
          </button>
        ) : (
          <span className="twisty" />
        )}
        <span className={`method-tag method-${node.method}`}>{shortMethod(node.method)}</span>
        <span className="tree-label">{node.name || node.url || 'Untitled'}</span>
        <Kebab open={menuOpen} setOpen={setMenuOpen} items={items} />
      </div>
      {showExamples && examples.length > 0 && (
        <div className="tree-children">
          {examples.map((example) => (
            <div
              key={example.id}
              className="tree-row example-row"
              style={{ paddingLeft: 8 + depth * 14 + 22 }}
              title={`${example.request?.method || node.method || 'GET'} ${
                example.request?.url || node.url || ''
              }`}
              onClick={() =>
                onOpenRequest(node, { tab: 'Examples', exampleId: example.id })
              }
            >
              <span className="tree-icon"><Icon name="file" size={14} /></span>
              <span className="tree-label">{example.name || 'Example'}</span>
              {example.response?.status != null && (
                <span className="example-status">{example.response.status}</span>
              )}
            </div>
          ))}
        </div>
      )}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={items}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
}

function Kebab({ open, setOpen, items }) {
  return (
    <span className="kebab-wrap" onClick={(e) => e.stopPropagation()}>
      <button className="kebab-btn" title="Actions" onClick={() => setOpen((v) => !v)}>
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

function shortMethod(m) {
  const map = { DELETE: 'DEL', OPTIONS: 'OPT', PATCH: 'PATCH' };
  return map[m] || m;
}
