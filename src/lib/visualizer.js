// pm.visualizer templates are HTML fragments with Postman-style {{tokens}}.
// Rendering happens inside a sandboxed iframe; this module only prepares the
// document string and never executes script.

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function readPath(data, path) {
  const parts = String(path || '')
    .trim()
    .split('.')
    .filter(Boolean);
  let current = data;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function asText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function renderVisualizerTemplate(template, data) {
  return String(template ?? '').replace(
    /\{\{\{\s*([^{}]+?)\s*\}\}\}|\{\{\s*([^{}]+?)\s*\}\}/g,
    (match, rawKey, escapedKey) => {
      const key = (rawKey ?? escapedKey).trim();
      if (!key || key.startsWith('#') || key.startsWith('/') || key.startsWith('!')) {
        return match;
      }
      const value = readPath(data, key);
      const text = asText(value);
      return rawKey != null ? text : escapeHtml(text);
    }
  );
}

export function buildVisualizerDocument(visualizer) {
  const template = visualizer?.template || '';
  const data = visualizer?.data;
  const body = template.trim()
    ? renderVisualizerTemplate(template, data)
    : `<pre>${escapeHtml(JSON.stringify(data ?? null, null, 2))}</pre>`;
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:;">',
    '<style>html,body{margin:0;padding:16px;font:13px/1.5 ui-sans-serif,system-ui,sans-serif;color:#1f2937;background:#fff}pre{margin:0;white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,monospace}</style>',
    '</head><body>',
    body,
    '</body></html>',
  ].join('');
}
