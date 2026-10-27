import React, { useEffect, useRef, useState } from 'react';
import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { useVarContext } from './VarContext.jsx';
import { graphqlCompletions } from '../lib/graphql.js';

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
  // `graphql` is registered by the bundled Monaco basic-languages
  // contribution (editor.main imports it), so hover previews keep working
  // after the GraphQL body editor switches off `plaintext`.
  const languages = ['json', 'javascript', 'plaintext', 'graphql'];
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
export default function CodeEditor({
  value,
  onChange,
  language = 'json',
  readOnly = false,
  height = '100%',
  graphqlSchema = null,
}) {
  const monacoRef = useRef(null);
  const [mounted, setMounted] = useState(false);
  const { lookup } = useVarContext();

  // Keep the shared ref pointing at this editor's (latest) lookup.
  useEffect(() => {
    currentLookupRef.fn = lookup || (() => null);
  }, [lookup]);

  // Monaco completion providers are global per language, so register a scoped
  // provider for the GraphQL query editor and dispose it when the schema prop
  // changes or the editor unmounts. Other language ids are untouched.
  useEffect(() => {
    const monacoApi = monacoRef.current;
    if (!mounted || !monacoApi || language !== 'graphql' || !graphqlSchema) return undefined;

    const disposable = monacoApi.languages.registerCompletionItemProvider('graphql', {
      provideCompletionItems(model, position) {
        const linePrefix = model.getValueInRange({
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        });
        const wordInfo = model.getWordUntilPosition(position);
        const items = graphqlCompletions({
          schema: graphqlSchema,
          word: wordInfo.word,
          linePrefix,
        });
        const range = new monacoApi.Range(
          position.lineNumber,
          wordInfo.startColumn,
          position.lineNumber,
          wordInfo.endColumn
        );
        return {
          suggestions: items.map((item) => ({
            label: item.label,
            kind:
              item.detail === 'operation'
                ? monacoApi.languages.CompletionItemKind.Keyword
                : /^[A-Z_]+$/.test(item.detail)
                  ? monacoApi.languages.CompletionItemKind.Class
                  : monacoApi.languages.CompletionItemKind.Field,
            insertText: item.insertText,
            detail: item.detail,
            range,
          })),
        };
      },
    });

    return () => disposable.dispose();
  }, [mounted, language, graphqlSchema]);

  function handleMount(editor, monacoApi) {
    monacoRef.current = monacoApi;
    defineMonacoThemes(monacoApi);
    monacoApi.editor.setTheme(monacoThemeName());
    // Follow the app theme: switching mode/accent re-defines the Monaco theme
    // from the live CSS tokens, so the editor matches the rest of the UI.
    const themeObserver = new MutationObserver(() => {
      defineMonacoThemes(monacoApi);
      monacoApi.editor.setTheme(monacoThemeName());
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-accent'],
    });
    editor.onDidDispose(() => themeObserver.disconnect());
    registerVarHover(monacoApi);
    applyVarDecorations(editor, monacoApi);
    editor.onDidChangeModelContent(() => applyVarDecorations(editor, monacoApi));
    setMounted(true);
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

function resolvedToken(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function monacoThemeName() {
  return document.documentElement.dataset.theme === 'light' ? 'relay-light' : 'relay-dark';
}

// Both themes are derived from the live CSS tokens so the editor follows the
// appearance setting instead of being permanently dark.
function defineMonacoThemes(monacoApi) {
  const accent = resolvedToken('--accent', '#ff6c37');
  monacoApi.editor.defineTheme('relay-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'string.key.json', foreground: '6ba9ff' },
      { token: 'string.value.json', foreground: '4caf50' },
      { token: 'number', foreground: 'e0a53b' },
      { token: 'keyword', foreground: 'a371f7' },
    ],
    colors: {
      'editor.background': resolvedToken('--bg-2', '#161a21'),
      'editorLineNumber.foreground': '#5a6166',
      'editorLineNumber.activeForeground': '#9aa3aa',
      'editor.lineHighlightBackground': resolvedToken('--bg-3', '#1e2430'),
      'editorCursor.foreground': accent,
    },
  });
  monacoApi.editor.defineTheme('relay-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'string.key.json', foreground: '2b6cb0' },
      { token: 'string.value.json', foreground: '15803d' },
      { token: 'number', foreground: 'b45309' },
      { token: 'keyword', foreground: '7c3aed' },
    ],
    colors: {
      'editor.background': resolvedToken('--bg-2', '#ffffff'),
      'editorLineNumber.foreground': '#9aa3b2',
      'editorLineNumber.activeForeground': '#4b5563',
      'editor.lineHighlightBackground': resolvedToken('--bg-3', '#f0f2f7'),
      'editorCursor.foreground': accent,
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
