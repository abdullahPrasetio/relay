import React, { useMemo } from 'react';
import { buildVisualizerDocument } from '../lib/visualizer.js';

// pm.visualizer payloads are rendered in a fully sandboxed iframe: no scripts,
// no same-origin access, and a CSP that blocks network requests.
export default function VisualizerPanel({ visualizer }) {
  const srcDoc = useMemo(() => buildVisualizerDocument(visualizer), [visualizer]);
  return (
    <div className="visualizer-panel">
      <iframe
        title="Visualizer"
        sandbox=""
        srcDoc={srcDoc}
        data-testid="visualizer-frame"
      />
    </div>
  );
}
