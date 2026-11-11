import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

// A right-click menu positioned at the pointer. Shares the kebab menu styling
// and item shape ({ label, onClick, danger? }) so both entry points stay in
// sync.
export default function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Keep the menu inside the viewport; measuring after mount avoids guessing
  // item heights.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  if (!items || items.length === 0) return null;

  return (
    <>
      <div
        className="kebab-backdrop"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div ref={ref} className="kebab-menu context-menu" style={pos} role="menu">
        {items.map((item, index) => (
          <button
            key={index}
            role="menuitem"
            className={`kebab-item ${item.danger ? 'danger' : ''}`}
            onClick={() => {
              onClose();
              item.onClick();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}
