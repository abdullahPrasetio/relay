import React, { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { filterSnippets } from '../lib/scriptSnippets.js';
import { filterPackages } from '../../packages/core/src/script-packages.js';

// Insert text at the current Monaco selection/cursor. Newlines are added only
// when needed so a snippet clicked on an empty line does not create a blank
// line above it.
function insertAtCursor(editor, text) {
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection) return;

  const start = selection.getStartPosition();
  const end = selection.getEndPosition();
  const lineBefore = model.getValueInRange({
    startLineNumber: start.lineNumber,
    startColumn: 1,
    endLineNumber: start.lineNumber,
    endColumn: start.column,
  });
  const lineAfter = model.getValueInRange({
    startLineNumber: end.lineNumber,
    startColumn: end.column,
    endLineNumber: end.lineNumber,
    endColumn: model.getLineMaxColumn(end.lineNumber),
  });
  const prefix = selection.isEmpty() && lineBefore.trim() ? '\n' : '';
  const suffix = selection.isEmpty() && lineAfter.trim() ? '\n' : '';
  const insert = `${prefix}${text}${suffix}`;

  editor.pushUndoStop();
  editor.executeEdits('relay-script-tools', [
    { range: selection, text: insert, forceMoveMarkers: true },
  ]);
  editor.pushUndoStop();
  editor.focus();
}

export default function ScriptTools({ editor, phase = 'both' }) {
  const [open, setOpen] = useState(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef(null);
  const inputRef = useRef(null);

  const snippets = useMemo(() => filterSnippets(query, phase), [query, phase]);
  const packages = useMemo(() => filterPackages(query), [query]);
  const visible = open === 'packages' ? packages : snippets;

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(null);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(0);
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open, query]);

  function toggle(kind) {
    setQuery('');
    setActiveIndex(0);
    setOpen((current) => (current === kind ? null : kind));
  }

  function choose(item) {
    if (!editor || !item) return;
    insertAtCursor(editor, item.code ?? item.example ?? '');
    setOpen(null);
    setQuery('');
  }

  function onSearchKeyDown(event) {
    if (event.key === 'Escape') {
      setOpen(null);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, visible.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      choose(visible[activeIndex]);
    }
  }

  return (
    <div className="script-tools" ref={rootRef}>
      <button
        type="button"
        className="script-tool-btn"
        data-testid="script-snippets-open"
        aria-expanded={open === 'snippets'}
        disabled={!editor}
        onClick={() => toggle('snippets')}
      >
        <Icon name="code" size={13} />
        Snippets
      </button>
      <button
        type="button"
        className="script-tool-btn"
        data-testid="script-packages-open"
        aria-expanded={open === 'packages'}
        disabled={!editor}
        onClick={() => toggle('packages')}
      >
        <Icon name="folder" size={13} />
        Packages
      </button>

      {open && (
        <div
          className="script-tools-popover"
          role="dialog"
          aria-label={open === 'packages' ? 'Packages' : 'Snippets'}
          data-testid={`script-${open}-popover`}
        >
          <div className="script-tools-search">
            <Icon name="search" size={14} />
            <input
              ref={inputRef}
              type="text"
              value={query}
              placeholder={open === 'packages' ? 'Search packages' : 'Search snippets'}
              data-testid="script-tools-search"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
            />
          </div>
          <div className="script-tools-list">
            {visible.length === 0 && <div className="script-tools-empty">No results</div>}
            {visible.map((item, index) => {
              const previous = visible[index - 1];
              const showGroup =
                open === 'snippets' && (!previous || previous.category !== item.category);
              return (
                <React.Fragment key={item.id}>
                  {showGroup && <div className="script-tools-group">{item.category}</div>}
                  <button
                    type="button"
                    className={`script-tools-item${index === activeIndex ? ' active' : ''}`}
                    data-testid={`script-item-${item.id}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => choose(item)}
                  >
                    <span className="script-tools-item-name">{item.name}</span>
                    {open === 'packages' && (
                      <span className="script-tools-item-meta">{item.description}</span>
                    )}
                  </button>
                </React.Fragment>
              );
            })}
          </div>
          <div className="script-tools-foot">
            {open === 'packages'
              ? 'Only bundled packages are available.'
              : 'Click a snippet to insert it at the cursor.'}
          </div>
        </div>
      )}
    </div>
  );
}
