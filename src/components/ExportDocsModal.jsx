import React, { useEffect, useMemo, useState } from 'react';
import Modal from './Modal.jsx';
import { collectionToHtml } from '../lib/apiDocs.js';
import {
  DEFAULT_DOCS_OPTIONS,
  DOC_LANGUAGES,
  DOC_TEMPLATES,
  DOC_THEMES,
  readDocsOptions,
  writeDocsOptions,
} from '../lib/docsExportOptions.js';
import { accentHex, readAppearance } from '../lib/theme.js';

export default function ExportDocsModal({
  collection,
  workspaceName = '',
  environment = null,
  globals = [],
  onExport,
  onClose,
}) {
  const [options, setOptions] = useState(() => {
    const saved = readDocsOptions();
    const accent =
      saved.accent === DEFAULT_DOCS_OPTIONS.accent
        ? accentHex(readAppearance())
        : saved.accent;
    return { ...saved, accent };
  });
  const [preview, setPreview] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [previewAt] = useState(() => new Date().toISOString());
  const [previewLoaded, setPreviewLoaded] = useState(false);

  const set = (patch) => setOptions((prev) => ({ ...prev, ...patch }));
  const html = useMemo(
    () =>
      collectionToHtml(collection, {
        ...options,
        workspaceName,
        environment,
        globals,
        generatedAt: previewAt,
      }),
    [collection, options, workspaceName, environment, globals, previewAt]
  );

  useEffect(() => {
    setPreviewLoaded(false);
  }, [html, preview]);

  async function submit(format) {
    setExporting(true);
    setError('');
    try {
      writeDocsOptions(options);
      const result = await onExport({ ...options, format });
      if (result?.ok && result.saved !== false) onClose();
      else if (result?.error) setError(result.error);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setExporting(false);
    }
  }

  return (
    <Modal
      title="Export documentation"
      onClose={onClose}
      width={780}
      footer={
        <>
          <button type="button" className="mini-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="mini-btn"
            data-testid="docs-export-preview-toggle"
            onClick={() => setPreview((value) => !value)}
          >
            {preview ? 'Edit options' : 'Preview'}
          </button>
          <button
            type="button"
            className="mini-btn"
            data-testid="docs-export-submit"
            onClick={() => submit('html')}
            disabled={exporting}
          >
            {exporting ? 'Exporting…' : 'Export HTML'}
          </button>
          <button
            type="button"
            className="send-btn"
            data-testid="docs-export-pdf"
            onClick={() => submit('pdf')}
            disabled={exporting}
          >
            {exporting ? 'Exporting…' : 'Export PDF'}
          </button>
        </>
      }
    >
      <div className="docs-export" data-testid="docs-export-modal">
        {preview ? (
          <div className="docs-export-preview-wrap">
            <iframe
              className="docs-export-preview"
              title="Documentation preview"
              sandbox="allow-scripts"
              srcDoc={html}
              onLoad={() => setPreviewLoaded(true)}
              data-testid="docs-export-preview"
            />
            {!previewLoaded && (
              <div className="docs-export-preview-loading">Rendering preview…</div>
            )}
          </div>
        ) : (
          <>
            {error && <p className="auth-hint settings-error">{error}</p>}
            <div className="docs-export-section-title">Template</div>
            <div className="docs-export-templates">
              {DOC_TEMPLATES.map((template) => (
                <label
                  key={template.id}
                  className={`docs-export-template${
                    options.template === template.id ? ' active' : ''
                  }`}
                >
                  <input
                    type="radio"
                    name="docs-template"
                    value={template.id}
                    checked={options.template === template.id}
                    onChange={() => set({ template: template.id })}
                    data-testid={`docs-template-${template.id}`}
                  />
                  <strong>{template.label}</strong>
                  <span>{template.detail}</span>
                </label>
              ))}
            </div>

            <div className="docs-export-section-title">Variables</div>
            <label className="settings-check docs-export-check">
              <input
                type="checkbox"
                checked={options.resolveVariables}
                onChange={(event) => set({ resolveVariables: event.target.checked })}
                data-testid="docs-export-resolve-vars"
              />
              Resolve variables from the active environment
            </label>
            <p className="auth-hint docs-export-hint">
              Secret variables are never resolved or exported.
              {environment?.name ? ` Active environment: ${environment.name}.` : ''}
            </p>

            <div className="docs-export-grid">
              <label className="form-row">
                <span>Theme</span>
                <select
                  value={options.theme}
                  onChange={(event) => set({ theme: event.target.value })}
                  data-testid="docs-export-theme"
                >
                  {DOC_THEMES.map((theme) => (
                    <option key={theme.id} value={theme.id}>
                      {theme.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="form-row">
                <span>Accent</span>
                <input
                  type="color"
                  value={options.accent}
                  onChange={(event) => set({ accent: event.target.value })}
                  data-testid="docs-export-accent"
                />
              </label>
              <label className="form-row">
                <span>Metadata language</span>
                <select
                  title="Language for metadata and disclaimer labels"
                  value={options.language}
                  onChange={(event) => set({ language: event.target.value })}
                  data-testid="docs-export-language"
                >
                  {DOC_LANGUAGES.map((language) => (
                    <option key={language.id} value={language.id}>
                      {language.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="docs-export-section-title">Document details</div>
            <div className="docs-export-grid">
              <label className="form-row docs-export-wide">
                <span>Document title</span>
                <input
                  value={options.documentTitle}
                  placeholder={collection?.name || 'Collection'}
                  onChange={(event) => set({ documentTitle: event.target.value })}
                  data-testid="docs-export-title"
                />
              </label>
              <label className="form-row">
                <span>Prepared by</span>
                <input
                  value={options.author}
                  onChange={(event) => set({ author: event.target.value })}
                  data-testid="docs-export-author"
                />
              </label>
              <label className="form-row">
                <span>Prepared for</span>
                <input
                  value={options.preparedFor}
                  onChange={(event) => set({ preparedFor: event.target.value })}
                  data-testid="docs-export-prepared-for"
                />
              </label>
              <label className="form-row">
                <span>Organization</span>
                <input
                  value={options.organization}
                  onChange={(event) => set({ organization: event.target.value })}
                  data-testid="docs-export-organization"
                />
              </label>
              <label className="form-row">
                <span>Version</span>
                <input
                  value={options.version}
                  onChange={(event) => set({ version: event.target.value })}
                  data-testid="docs-export-version"
                />
              </label>
              <label className="form-row">
                <span>Classification</span>
                <input
                  value={options.classification}
                  placeholder="Internal, Confidential, Public…"
                  onChange={(event) => set({ classification: event.target.value })}
                  data-testid="docs-export-classification"
                />
              </label>
            </div>

            <label className="settings-check docs-export-check">
              <input
                type="checkbox"
                checked={options.includeExamples}
                onChange={(event) => set({ includeExamples: event.target.checked })}
                data-testid="docs-export-examples"
              />
              Include saved examples
            </label>

            <div className="docs-export-section-title">Watermark</div>
            <label className="settings-check docs-export-check">
              <input
                type="checkbox"
                checked={options.watermark}
                onChange={(event) => set({ watermark: event.target.checked })}
                data-testid="docs-export-watermark"
              />
              Include watermark (on by default)
            </label>
            <p className="auth-hint docs-export-hint">
              Uncheck to remove the watermark from this export. New exports start with it on.
            </p>
            <label className="form-row">
              <span>Watermark text (leave empty for Prepared by / Prepared for)</span>
              <input
                value={options.watermarkText}
                onChange={(event) => set({ watermarkText: event.target.value })}
                data-testid="docs-export-watermark-text"
              />
            </label>

            <div className="docs-export-section-title">Collection appendix</div>
            <label className="settings-check docs-export-check">
              <input
                type="checkbox"
                checked={options.includeCollectionSummary}
                onChange={(event) => set({ includeCollectionSummary: event.target.checked })}
                data-testid="docs-export-summary"
              />
              Include collection summary
            </label>
            <label className="settings-check docs-export-check">
              <input
                type="checkbox"
                checked={options.includeCollectionJson}
                onChange={(event) => set({ includeCollectionJson: event.target.checked })}
                data-testid="docs-export-json"
              />
              Include full collection JSON (secrets redacted)
            </label>

            <div className="docs-export-section-title">Disclaimer</div>
            <label className="form-row">
              <span>Disclaimer text (leave empty to omit)</span>
              <textarea
                rows={5}
                value={options.disclaimer}
                onChange={(event) => set({ disclaimer: event.target.value })}
                data-testid="docs-export-disclaimer"
              />
            </label>
          </>
        )}
      </div>
    </Modal>
  );
}
