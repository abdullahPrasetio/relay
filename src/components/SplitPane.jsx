import React, { useCallback, useEffect, useRef, useState } from 'react';

// Vertical split with a draggable divider between request (top) and
// response (bottom). Remembers the split ratio in localStorage. `minTop` and
// `minBottom` are pixel floors so a pane can collapse to its header instead of
// disappearing entirely (Postman-style full-height request/response).
export default function SplitPane({
  children,
  storageKey = 'split',
  min = 0,
  max = 1,
  minTop = 0,
  minBottom = 0,
}) {
  const [top, bottom] = React.Children.toArray(children);
  const containerRef = useRef(null);
  const [ratio, setRatio] = useState(() => {
    const raw = localStorage.getItem(storageKey);
    const saved = Number(raw);
    return raw !== null && Number.isFinite(saved) && saved >= 0 && saved <= 1 ? saved : 0.5;
  });
  const dragging = useRef(false);

  const clampRatio = useCallback(
    (value) => {
      const height = containerRef.current?.getBoundingClientRect().height || 0;
      let lo = min;
      let hi = max;
      if (height > 0) {
        if (minTop > 0) lo = Math.max(lo, minTop / height);
        if (minBottom > 0) hi = Math.min(hi, 1 - minBottom / height);
      }
      if (lo > hi) return 0.5;
      return Math.max(lo, Math.min(hi, value));
    },
    [min, max, minTop, minBottom]
  );

  const onMouseDown = useCallback((event) => {
    event.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, []);

  // A ratio saved before the pixel floors changed (or a full collapse saved by
  // an older build) must not leave a pane below its header height.
  useEffect(() => {
    setRatio((current) => clampRatio(current));
  }, [clampRatio]);

  useEffect(() => {
    function onMove(e) {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      setRatio(clampRatio((e.clientY - rect.top) / rect.height));
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
  }, [ratio, storageKey, clampRatio]);

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
