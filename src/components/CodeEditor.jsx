import React, { useEffect, useRef } from 'react';
import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { useVarContext } from './VarContext.jsx';

// Use the locally bundled monaco (not the CDN) so it works under the strict
// Content Security Policy (script-src 'self') in the Electron renderer.
loader.config({ monaco });

// Hover providers are global in Monaco, so register once and read the latest
// variable lookup from a shared ref (updated by whichever editor is mounted).
let hoverRegistered = false;
const currentLookupRef = { fn: () => null };

function registerVarHover(monacoApi) {
  if (hoverRegistered) return;
  hoverRegistered = true;
  const languages = ['json', 'javascript', 'plaintext'];
  const VAR_AT = /\{\{\s*([\w.-]+)\s*\}\}/g;
  for (const lang of languages) {
    monacoApi.languages.registerHoverProvider(lang, {
      provideHover(model, position) {
        const line = model.getLineContent(position.lineNumber);
        VAR_AT.lastIndex = 0;
        let m;
        while ((m = VAR_AT.exec(line)) !== null) {
          const startCol = m.index + 1;
          const endCol = m.index + m[0].length + 1;
          if (position.column >= startCol && position.column <= endCol) {
            const name = m[1];
            const hit = currentLookupRef.fn(name);
            const scopeLabel = hit
              ? `${scopeShort(hit.scope)}  ${hit.scope}`
              : 'unresolved';
            const valueLine = hit ? `**${escapeMd(hit.value)}**` : '_variable is not defined_';
            return {
              range: new monacoApi.Range(
                position.lineNumber,
                startCol,
                position.lineNumber,
                endCol
              ),
              contents: [
                { value: valueLine },
                { value: scopeLabel },
              ],
            };
          }
        }
        return null;
      },
    });
  }
}

function scopeShort(scope) {
  if (scope === 'environment') return 'E';
  if (scope === 'collection') return 'C';
  if (scope === 'globals') return 'G';
  return '•';
}
function escapeMd(v) {
  return String(v ?? '').replace(/[*_`]/g, '\\$&');
}

// A Monaco-backed code editor with a dark theme, line numbers, {{variable}}
// highlighting, and hover previews of variable values (like Postman).
export default function CodeEditor({ value, onChange, language = 'json', readOnly = false, height = '100%' }) {
  const monacoRef = useRef(null);
  const { lookup } = useVarContext();

  // Keep the shared ref pointing at this editor's (latest) lookup.
  useEffect(() => {
    currentLookupRef.fn = lookup || (() => null);
  }, [lookup]);

  function handleMount(editor, monacoApi) {
    monacoRef.current = monacoApi;
    defineTheme(monacoApi);
    monacoApi.editor.setTheme('rest-tamer-dark');
    registerVarHover(monacoApi);
    applyVarDecorations(editor, monacoApi);
    editor.onDidChangeModelContent(() => applyVarDecorations(editor, monacoApi));
  }

  return (
    <Editor
      height={height}
      language={language}
      value={value || ''}
      onChange={(v) => onChange && onChange(v ?? '')}
      onMount={handleMount}
      options={{
        readOnly,
        minimap: { enabled: false },
        fontSize: 12.5,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        lineNumbers: 'on',
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        wordWrap: 'on',
        renderLineHighlight: 'line',
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      }}
    />
  );
}

let themeDefined = false;
function defineTheme(monacoApi) {
  if (themeDefined) return;
  themeDefined = true;
  monacoApi.editor.defineTheme('rest-tamer-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'string.key.json', foreground: '6ba9ff' },
      { token: 'string.value.json', foreground: '4caf50' },
      { token: 'number', foreground: 'e0a53b' },
      { token: 'keyword', foreground: 'a371f7' },
    ],
    colors: {
      'editor.background': '#1b1d1f',
      'editorLineNumber.foreground': '#5a6166',
      'editorLineNumber.activeForeground': '#9aa3aa',
      'editor.lineHighlightBackground': '#23262a',
      'editorCursor.foreground': '#ff6c37',
    },
  });
}

// Highlight {{variable}} tokens in orange, like Postman.
function applyVarDecorations(editor, monacoApi) {
  const model = editor.getModel();
  if (!model) return;
  const text = model.getValue();
  const re = /\{\{\s*[\w.-]+\s*\}\}/g;
  const decorations = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = model.getPositionAt(m.index);
    const end = model.getPositionAt(m.index + m[0].length);
    decorations.push({
      range: new monacoApi.Range(start.lineNumber, start.column, end.lineNumber, end.column),
      options: { inlineClassName: 'monaco-var-token' },
    });
  }
  editor._varDecorations = editor.deltaDecorations(editor._varDecorations || [], decorations);
}
