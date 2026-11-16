// Last-used HTML documentation export settings. This is renderer-only UI
// state; the generated document remains self-contained and never reads it.
export const DOCS_EXPORT_OPTIONS_KEY = 'relay-docs-export-options';

export const DOC_TEMPLATES = [
  { id: 'classic', label: 'Classic', detail: 'Current Relay layout with cards and a table of contents.' },
  { id: 'professional', label: 'Professional', detail: 'Formal cover, metadata block, and accent header.' },
  { id: 'minimal', label: 'Minimal', detail: 'Clean typography for print and PDF.' },
];

export const DOC_THEMES = [
  { id: 'system', label: 'Follow system' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

export const DOC_LANGUAGES = [
  { id: 'en', label: 'English' },
  { id: 'id', label: 'Indonesia' },
];

export const DEFAULT_DOCS_DISCLAIMER =
  "This document is provided for informational purposes only. Relay and its contributors make no representations or warranties regarding its accuracy, completeness, or fitness for any purpose. Any reliance on this document is at the reader's own risk. Relay is not liable for any loss, damage, or liability arising from its use. Always verify requests and responses against the live API.";

export const DEFAULT_DOCS_OPTIONS = Object.freeze({
  template: 'classic',
  theme: 'system',
  accent: '#6366f1',
  language: 'en',
  includeExamples: true,
  resolveVariables: true,
  watermark: true,
  watermarkText: '',
  includeCollectionSummary: true,
  includeCollectionJson: false,
  documentTitle: '',
  author: '',
  preparedFor: '',
  organization: '',
  version: '',
  classification: '',
  disclaimer: DEFAULT_DOCS_DISCLAIMER,
});

function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

export function normalizeDocsOptions(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    template: DOC_TEMPLATES.some((entry) => entry.id === src.template)
      ? src.template
      : DEFAULT_DOCS_OPTIONS.template,
    theme: DOC_THEMES.some((entry) => entry.id === src.theme)
      ? src.theme
      : DEFAULT_DOCS_OPTIONS.theme,
    accent: /^#[0-9a-f]{6}$/i.test(text(src.accent))
      ? text(src.accent)
      : DEFAULT_DOCS_OPTIONS.accent,
    language: DOC_LANGUAGES.some((entry) => entry.id === src.language)
      ? src.language
      : DEFAULT_DOCS_OPTIONS.language,
    includeExamples: src.includeExamples !== false,
    resolveVariables: src.resolveVariables !== false,
    // Watermark is mandatory-by-default; unchecking only affects the
    // current export and is not persisted as the next default.
    watermark: true,
    watermarkText: text(src.watermarkText),
    includeCollectionSummary: src.includeCollectionSummary !== false,
    includeCollectionJson: src.includeCollectionJson === true,
    documentTitle: text(src.documentTitle),
    author: text(src.author),
    preparedFor: text(src.preparedFor),
    organization: text(src.organization),
    version: text(src.version),
    classification: text(src.classification),
    disclaimer: text(src.disclaimer, DEFAULT_DOCS_OPTIONS.disclaimer),
  };
}

export function readDocsOptions(storage) {
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  try {
    const raw = store?.getItem(DOCS_EXPORT_OPTIONS_KEY);
    return raw ? normalizeDocsOptions(JSON.parse(raw)) : { ...DEFAULT_DOCS_OPTIONS };
  } catch {
    return { ...DEFAULT_DOCS_OPTIONS };
  }
}

export function writeDocsOptions(options, storage) {
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  try {
    store?.setItem(DOCS_EXPORT_OPTIONS_KEY, JSON.stringify(normalizeDocsOptions(options)));
    return true;
  } catch {
    return false;
  }
}
