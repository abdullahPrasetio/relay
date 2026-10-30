import React, { useEffect, useMemo, useState } from 'react';
import Modal from './Modal.jsx';
import { collectionToConfluenceStorage } from '../lib/confluenceDocs.js';
import {
  formatSyncTime,
  pageLink,
  parsePageId,
} from '../lib/confluenceUi.js';

// Publish one collection to Confluence. Update-only is the default: a page ID
// is enough. Create is opt-in and requires a space + explicit parent so a page
// can never land directly under the space root by accident.
export default function ConfluenceSyncModal({ workspace, collection, onChange, onClose }) {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pageId, setPageId] = useState(collection.confluencePageId || '');
  const [linkDraft, setLinkDraft] = useState('');
  const [title, setTitle] = useState(
    collection.confluenceTitle || collection.name || 'Collection'
  );
  const [spaceKey, setSpaceKey] = useState(collection.confluenceSpaceKey || '');
  const [parentPageId, setParentPageId] = useState(
    collection.confluenceParentPageId || ''
  );
  const [includeExamples, setIncludeExamples] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(null);
  const bridge = typeof window !== 'undefined' ? window.api : null;

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!bridge?.confluenceGetConfig) {
        setError('Confluence is only available in the desktop app.');
        setLoading(false);
        return;
      }
      try {
        const res = await bridge.confluenceGetConfig(workspace.id);
        if (!alive) return;
        if (!res?.ok) setError(res?.error || 'Could not load Confluence settings.');
        else setConfig(res.config);
      } catch (err) {
        if (alive) setError(err?.message || String(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [bridge, workspace.id]);

  const configured = Boolean(config?.hasToken);
  const link = useMemo(
    () => pageLink(config, pageId, pageId === collection.confluencePageId ? collection.confluencePageUrl : ''),
    [config, pageId, collection.confluencePageId, collection.confluencePageUrl]
  );

  async function publish({ mode, force = false, pageIdOverride = '' } = {}) {
    const effTitle = title.trim();
    if (!effTitle) {
      setError('Page title is required.');
      return;
    }
    const updateId = parsePageId(pageIdOverride || pageId);
    if (mode === 'update' && !updateId) {
      setError('Paste a valid Confluence page ID or URL.');
      return;
    }
    const effSpace = spaceKey.trim();
    const effParent = parsePageId(parentPageId);
    if (mode === 'create') {
      if (!effSpace) {
        setError('Space key is required to create a page.');
        return;
      }
      if (!effParent) {
        setError('Choose a parent page before creating a page.');
        return;
      }
    }

    setBusy(true);
    setError('');
    setNotice('');
    setConflict(null);
    try {
      const content = collectionToConfluenceStorage(collection, {
        workspaceName: workspace.name,
        includeExamples,
        generatedAt: new Date().toISOString(),
      });
      const res = await bridge.confluencePublish({
        workspaceId: workspace.id,
        collectionId: collection.id,
        pageId: mode === 'update' ? updateId : '',
        title: effTitle,
        content,
        spaceKey: mode === 'create' ? effSpace : effSpace,
        parentPageId: mode === 'create' ? effParent : effParent,
        force,
      });

      if (res?.ok) {
        const now = new Date().toISOString();
        setPageId(res.pageId);
        onChange({
          ...collection,
          confluencePageId: res.pageId,
          confluencePageUrl: res.url || '',
          confluenceTitle: res.title || effTitle,
          confluenceSpaceKey: res.spaceKey || effSpace,
          confluenceParentPageId: res.parentPageId || effParent,
          confluenceSyncedAt: now,
          confluenceVersion: res.version ?? null,
        });
        setNotice(
          `${res.created ? 'Created' : 'Updated'} page${res.version ? ` (v${res.version})` : ''}.`
        );
        return;
      }

      if (res?.code === 'title_conflict') {
        setConflict({
          code: 'title',
          existingId: res.existingId,
          existingUrl: res.existingUrl,
          message: res.error || 'A page with this title already exists.',
        });
        setError(res?.error || 'A page with this title already exists.');
        return;
      }
      if (res?.code === 'conflict') {
        setConflict({
          code: 'version',
          currentVersion: res.currentVersion,
          message: res.error || 'This page changed since it was loaded.',
        });
        setError(res?.error || 'This page changed since it was loaded.');
        return;
      }
      setError(res?.error || 'Confluence publish failed.');
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  const lastSync = formatSyncTime(collection.confluenceSyncedAt);

  return (
    <Modal
      title={`Confluence · ${collection.name}`}
      onClose={onClose}
      width={680}
      footer={
        <>
          <button className="mini-btn" onClick={onClose}>
            Close
          </button>
          {pageId ? (
            <button
              className="send-btn"
              data-testid="confluence-update"
              onClick={() => publish({ mode: 'update' })}
              disabled={busy || !configured}
            >
              {busy ? 'Publishing…' : 'Update page'}
            </button>
          ) : (
            <button
              className="send-btn"
              data-testid="confluence-create"
              onClick={() => publish({ mode: 'create' })}
              disabled={
                busy ||
                !configured ||
                !spaceKey.trim() ||
                !parsePageId(parentPageId)
              }
            >
              {busy ? 'Publishing…' : 'Create page'}
            </button>
          )}
        </>
      }
    >
      {loading ? (
        <p className="auth-hint">Loading…</p>
      ) : (
        <>
          {!configured && (
            <p className="auth-hint settings-error" data-testid="confluence-not-configured">
              Configure Confluence first: Workspace menu → Confluence settings. The token
              stays on this machine.
            </p>
          )}
          {error && (
            <p className="auth-hint settings-error" data-testid="confluence-sync-error">
              {error}
            </p>
          )}
          {notice && (
            <p className="auth-hint" data-testid="confluence-sync-notice">
              {notice}
            </p>
          )}

          <div className="form-row">
            <label htmlFor="confluence-page-title">Page title</label>
            <input
              id="confluence-page-title"
              data-testid="confluence-page-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={collection.name}
            />
            <p className="auth-hint">
              Titles must be unique inside the space; a clash is reported before writing.
            </p>
          </div>

          <label className="settings-check">
            <input
              type="checkbox"
              data-testid="confluence-include-examples"
              checked={includeExamples}
              onChange={(e) => setIncludeExamples(e.target.checked)}
            />
            Include saved examples
          </label>

          {conflict?.code === 'title' && (
            <div className="confluence-conflict" data-testid="confluence-title-conflict">
              <strong>Title already used</strong>
              <p>{conflict.message}</p>
              {conflict.existingUrl && (
                <a
                  href={conflict.existingUrl}
                  onClick={(e) => {
                    e.preventDefault();
                    bridge?.openExternal?.(conflict.existingUrl);
                  }}
                >
                  Open existing page
                </a>
              )}
              <div className="confluence-conflict-actions">
                <button
                  className="mini-btn"
                  data-testid="confluence-use-existing"
                  onClick={() => {
                    setPageId(String(conflict.existingId || ''));
                    setConflict(null);
                    setError('');
                  }}
                >
                  Link this page instead
                </button>
                <button className="mini-btn" onClick={() => setConflict(null)}>
                  Change title
                </button>
              </div>
            </div>
          )}

          {conflict?.code === 'version' && (
            <div className="confluence-conflict" data-testid="confluence-version-conflict">
              <strong>Page changed since it was loaded</strong>
              <p>
                {conflict.message} Current version: {conflict.currentVersion ?? 'unknown'}.
              </p>
              <div className="confluence-conflict-actions">
                <button
                  className="send-btn"
                  data-testid="confluence-overwrite"
                  onClick={() => publish({ mode: 'update', force: true })}
                  disabled={busy}
                >
                  Overwrite page
                </button>
                <button className="mini-btn" onClick={() => setConflict(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {pageId ? (
            <div className="confluence-page" data-testid="confluence-linked-page">
              <div className="mock-section-title">Existing page</div>
              <p>
                Page ID <code>{pageId}</code>
                {collection.confluenceVersion ? ` · last version ${collection.confluenceVersion}` : ''}
                {lastSync ? ` · synced ${lastSync}` : ''}
              </p>
              {link && (
                <a
                  href={link}
                  data-testid="confluence-page-link"
                  onClick={(e) => {
                    e.preventDefault();
                    bridge?.openExternal?.(link);
                  }}
                >
                  Open in Confluence
                </a>
              )}
              <div className="form-row" style={{ marginTop: 12 }}>
                <label htmlFor="confluence-page-id">Change page ID</label>
                <input
                  id="confluence-page-id"
                  data-testid="confluence-page-id"
                  value={pageId}
                  onChange={(e) => setPageId(e.target.value)}
                  placeholder="123456 or page URL"
                />
              </div>
            </div>
          ) : (
            <div className="confluence-page" data-testid="confluence-link-panel">
              <div className="mock-section-title">Link an existing page</div>
              <div className="form-row">
                <label htmlFor="confluence-existing-id">Page ID or URL</label>
                <input
                  id="confluence-existing-id"
                  data-testid="confluence-existing-id"
                  value={linkDraft}
                  onChange={(e) => setLinkDraft(e.target.value)}
                  placeholder="123456 or https://…/pages/123456"
                />
              </div>
              <button
                type="button"
                className="mini-btn"
                data-testid="confluence-link-existing"
                onClick={() => {
                  const id = parsePageId(linkDraft);
                  if (!id) {
                    setError('Paste a valid Confluence page ID or URL.');
                    return;
                  }
                  setError('');
                  setPageId(id);
                  setLinkDraft('');
                }}
              >
                Link this page
              </button>
              <p className="auth-hint">
                Update-only needs just this ID; space and parent are not used.
              </p>

              <div className="mock-section-title" style={{ marginTop: 18 }}>
                Create a new page
              </div>
              <div className="form-row">
                <label htmlFor="confluence-space">Space key</label>
                <input
                  id="confluence-space"
                  data-testid="confluence-space-key"
                  value={spaceKey}
                  onChange={(e) => setSpaceKey(e.target.value)}
                  placeholder="DOCS"
                />
              </div>
              <div className="form-row">
                <label htmlFor="confluence-parent">Parent page ID or URL</label>
                <input
                  id="confluence-parent"
                  data-testid="confluence-parent-id"
                  value={parentPageId}
                  onChange={(e) => setParentPageId(e.target.value)}
                  placeholder="123456 — required for create"
                />
              </div>
              <p className="auth-hint">
                Create always places the page under this parent. To create at the space
                root, create the page in Confluence first and link it above.
              </p>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
