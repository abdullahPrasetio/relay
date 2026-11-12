import React, { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';

// Cmd/Ctrl+K palette: search requests, collections, environments and actions.
// Items are supplied by App so the palette stays free of store knowledge.
export default function CommandPalette({ open, items = [], onClose }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    setQuery('');
    setActive(0);
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) =>
      `${item.label} ${item.detail || ''} ${item.keywords || ''}`.toLowerCase().includes(q)
    );
  }, [items, query]);

  useEffect(() => {
    if (active >= filtered.length) setActive(0);
  }, [active, filtered.length]);

  if (!open) return null;

  function run(item) {
    if (!item) return;
    onClose?.();
    item.run?.();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose?.();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (filtered.length === 0) return;
      setActive((index) => Math.min(index + 1, filtered.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (filtered.length === 0) return;
      setActive((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (filtered.length > 0) run(filtered[active]);
    }
  }

  return (
    <div
      className="command-backdrop"
      data-testid="command-palette"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <div className="command-palette" role="dialog" aria-label="Command palette">
        <div className="command-search">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            className="command-input"
            data-testid="command-input"
            value={query}
            placeholder="Search requests, collections, or commands…"
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          <span className="command-esc">Esc</span>
        </div>
        <div className="command-list">
          {filtered.length === 0 && <div className="command-empty">No matches</div>}
          {filtered.map((item, index) => {
            const previous = filtered[index - 1];
            return (
              <React.Fragment key={item.id}>
                {(!previous || previous.group !== item.group) && (
                  <div className="command-group">{item.group}</div>
                )}
                <button
                  type="button"
                  className={`command-item${index === active ? ' active' : ''}`}
                  data-testid={`command-item-${item.id}`}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => run(item)}
                >
                  <span className="command-icon">
                    <Icon name={item.icon || 'search'} size={15} />
                  </span>
                  <span className="command-copy">
                    <span className="command-label">{item.label}</span>
                    {item.detail && <span className="command-detail">{item.detail}</span>}
                  </span>
                  {item.hint && <span className="command-hint">{item.hint}</span>}
                </button>
              </React.Fragment>
            );
          })}
        </div>
        <div className="command-foot">
          <span><span className="command-key">↑↓</span> Navigate</span>
          <span><span className="command-key">↵</span> Open</span>
          <span><span className="command-key">Esc</span> Close</span>
        </div>
      </div>
    </div>
  );
}
