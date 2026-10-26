import React, { useCallback, useEffect, useRef, useState } from 'react';

// Vertical split with a draggable divider between request (top) and
// response (bottom). Remembers the split ratio in localStorage.
export default function SplitPane({ children, storageKey = 'split', min = 0.2, max = 0.8 }) {
  const [top, bottom] = React.Children.toArray(children);
  const containerRef = useRef(null);
  const [ratio, setRatio] = useState(() => {
    const saved = Number(localStorage.getItem(storageKey));
    return saved > 0 && saved < 1 ? saved : 0.5;
  });
  const dragging = useRef(false);

  const onMouseDown = useCallback(() => {
    dragging.current = true;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    function onMove(e) {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      let r = (e.clientY - rect.top) / rect.height;
      r = Math.max(min, Math.min(max, r));
      setRatio(r);
    }
    function onUp() {
      if (dragging.current) {
        dragging.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        localStorage.setItem(storageKey, String(ratio));
      }
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [ratio, min, max, storageKey]);

  return (
    <div className="split-pane" ref={containerRef}>
      <div className="split-top" style={{ flexBasis: `${ratio * 100}%` }}>
        {top}
      </div>
      <div className="split-divider" onMouseDown={onMouseDown} title="Drag to resize" />
      <div className="split-bottom" style={{ flexBasis: `${(1 - ratio) * 100}%` }}>
        {bottom}
      </div>
    </div>
  );
}
