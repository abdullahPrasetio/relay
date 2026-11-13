import React, { useMemo } from 'react';
import Icon from './Icon.jsx';
import { flattenRequests } from '../lib/collectionTree.js';
import { countValidatedFields } from '../lib/fieldValidations.js';

function collectRequests(items, path = [], out = []) {
  for (const node of items || []) {
    if (node.type === 'folder') {
      collectRequests(node.items, [...path, node.name], out);
    } else {
      out.push({ request: node, path });
    }
  }
  return out;
}

function variableRows(rows) {
  return (rows || []).filter((row) => row && row.key);
}

function displayValue(row) {
  if (row.type === 'secret') return '••••';
  return row.value ?? '';
}

function authLabel(auth) {
  const type = auth?.type || 'inherit';
  if (type === 'inherit') return 'Inherit from parent';
  if (type === 'none') return 'No auth';
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function RequestDocCard({ entry, onOpenRequest }) {
  const { request, path } = entry;
  const params = (request.params || []).filter((row) => row.enabled !== false && row.key);
  const headers = (request.headers || []).filter((row) => row.enabled !== false && row.key);
  const validations = countValidatedFields(request.fieldValidations);
  const examples = Array.isArray(request.examples) ? request.examples.length : 0;
  const bodyMode = request.body?.mode || 'none';
  return (
    <article className="docs-request-card">
      <div className="docs-request-head">
        <span className={`method-tag method-${request.method}`}>{request.method || 'GET'}</span>
        <div className="docs-request-title">
          <strong>{request.name || request.url || 'Untitled request'}</strong>
          <code>{request.url || 'No URL'}</code>
          {path.length > 0 && <span className="docs-path">{path.join(' / ')}</span>}
        </div>
        <button
          type="button"
          className="mini-btn"
          onClick={() => onOpenRequest?.(request, { tab: 'Docs' })}
        >
          Open request
        </button>
      </div>
      {request.description && <p className="docs-description">{request.description}</p>}
      <div className="docs-meta">
        <span>{params.length} params</span>
        <span>{headers.length} headers</span>
        <span>body: {bodyMode}</span>
        {validations > 0 && <span>{validations} documented fields</span>}
        {examples > 0 && <span>{examples} examples</span>}
        {request.preRequest?.trim() && <span>pre-request script</span>}
        {request.tests?.trim() && <span>tests</span>}
      </div>
    </article>
  );
}

export default function DocsPage({
  workspace,
  target,
  onOpenCollection,
  onOpenRequest,
}) {
  const collections = useMemo(() => workspace?.collections || [], [workspace?.collections]);
  const selectedCollection =
    target?.type === 'collection'
      ? collections.find((collection) => collection.id === target.collectionId)
      : null;

  const workspaceStats = useMemo(() => {
    const requests = collections.reduce(
      (total, collection) => total + flattenRequests(collection).length,
      0
    );
    return {
      collections: collections.length,
      requests,
      environments: (workspace?.environments || []).length,
    };
  }, [collections, workspace?.environments]);

  if (!selectedCollection) {
    return (
      <section className="docs-page" data-testid="docs-workspace" data-tour="docs.workspace">
        <header className="docs-page-head">
          <div className="docs-kicker">Workspace documentation</div>
          <h1>{workspace?.name || 'Workspace'}</h1>
          <p>Browse every collection and request in this workspace.</p>
        </header>
        <div className="docs-stats">
          <div><strong>{workspaceStats.collections}</strong><span>Collections</span></div>
          <div><strong>{workspaceStats.requests}</strong><span>Requests</span></div>
          <div><strong>{workspaceStats.environments}</strong><span>Environments</span></div>
        </div>
        <div className="docs-section-title">Collections</div>
        {collections.length === 0 ? (
          <div className="docs-empty">No collections in this workspace.</div>
        ) : (
          <div className="docs-collection-grid">
            {collections.map((collection) => {
              const requestCount = flattenRequests(collection).length;
              return (
                <button
                  type="button"
                  key={collection.id}
                  className="docs-collection-card"
                  data-testid={`docs-collection-${collection.id}`}
                  onClick={() => onOpenCollection?.(collection.id)}
                >
                  <Icon name="collection" size={16} />
                  <span className="docs-collection-copy">
                    <strong>{collection.name}</strong>
                    <span>{requestCount} requests</span>
                    {collection.description && <small>{collection.description}</small>}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>
    );
  }

  const entries = collectRequests(selectedCollection.items);
  const variables = variableRows(selectedCollection.variables);

  return (
    <section className="docs-page" data-testid="docs-collection" data-tour="docs.collection">
      <header className="docs-page-head">
        <div className="docs-kicker">
          {workspace?.name || 'Workspace'} / Collection documentation
        </div>
        <h1>{selectedCollection.name}</h1>
        <p>{selectedCollection.description || 'No collection description yet.'}</p>
        <div className="docs-meta">
          <span>{entries.length} requests</span>
          <span>auth: {authLabel(selectedCollection.auth)}</span>
          <span>{variables.length} variables</span>
        </div>
      </header>

      {variables.length > 0 && (
        <div className="docs-section">
          <div className="docs-section-title">Variables</div>
          <table className="docs-table">
            <thead>
              <tr><th>Key</th><th>Value</th><th>Type</th></tr>
            </thead>
            <tbody>
              {variables.map((row) => (
                <tr key={row.key}>
                  <td><code>{row.key}</code></td>
                  <td>{displayValue(row)}</td>
                  <td>{row.type || 'default'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="docs-section-title">Requests</div>
      {entries.length === 0 ? (
        <div className="docs-empty">No requests in this collection.</div>
      ) : (
        <div className="docs-request-list">
          {entries.map((entry) => (
            <RequestDocCard
              key={entry.request.id}
              entry={entry}
              onOpenRequest={onOpenRequest}
            />
          ))}
        </div>
      )}
    </section>
  );
}
