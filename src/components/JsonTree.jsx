import React, { useState } from 'react';
import { jsonSubtreeMatches } from '../lib/responseFormat.js';
import '../styles/response.css';

/**
 * Collapsible JSON tree with a path/key filter. Every toggle is a real button,
 * so Tab/Enter/Space work without extra key handlers.
 */
export default function JsonTree({ data }) {
  const [filter, setFilter] = useState('');
  const query = filter.trim().toLowerCase();

  return (
    <div className="json-tree" data-testid="json-tree">
      <div className="json-tree-toolbar">
        <input
          className="json-tree-filter"
          data-testid="json-tree-filter"
          type="text"
          value={filter}
          placeholder="Filter paths or keys…"
          aria-label="Filter JSON tree"
          onChange={(e) => setFilter(e.target.value)}
        />
        {filter && (
          <button className="mini-btn" onClick={() => setFilter('')}>
            Clear
          </button>
        )}
      </div>
      <div className="json-tree-body">
        {query && !jsonSubtreeMatches('root', data, query, '') ? (
          <div className="json-empty-row">No matching paths</div>
        ) : (
          <JsonNode name="root" value={data} path="" depth={0} query={query} root />
        )}
      </div>
    </div>
  );
}

function JsonNode({ name, value, path, depth, query, root = false }) {
  const [open, setOpen] = useState(depth < 2);
  const isObject = value !== null && typeof value === 'object';
  const isArray = Array.isArray(value);
  const entries = isObject ? Object.entries(value) : [];

  if (query && !jsonSubtreeMatches(name, value, query, path)) return null;

  const currentPath = root ? '' : path ? `${path}.${name}` : String(name);
  const expanded = query ? true : open;

  return (
    <div className="json-node" style={{ paddingLeft: `${depth * 14}px` }}>
      <div className="json-node-row">
        {isObject ? (
          <button
            type="button"
            className="json-toggle"
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${root ? 'root' : name}`}
            onClick={() => setOpen((v) => !v)}
          >
            {expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="json-toggle-spacer" aria-hidden="true" />
        )}

        {!root && <span className="json-key">{name}</span>}
        {!root && <span className="json-colon">: </span>}

        {isObject ? (
          <span className="json-summary">
            <span className="json-brace">{isArray ? '[' : '{'}</span>
            <span className="json-count">
              {entries.length} {isArray ? (entries.length === 1 ? 'item' : 'items') : entries.length === 1 ? 'key' : 'keys'}
            </span>
            <span className="json-brace">{isArray ? ']' : '}'}</span>
          </span>
        ) : (
          renderPrimitive(value)
        )}
      </div>

      {isObject && expanded && (
        <div className="json-children">
          {entries.length === 0 && <div className="json-empty-row">(empty)</div>}
          {entries.map(([key, val]) => (
            <JsonNode
              key={`${currentPath}.${key}`}
              name={key}
              value={val}
              path={currentPath}
              depth={depth + 1}
              query={query}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function renderPrimitive(value) {
  if (value === null) return <span className="json-null">null</span>;
  if (typeof value === 'string') return <span className="json-string">&quot;{value}&quot;</span>;
  if (typeof value === 'number') return <span className="json-number">{String(value)}</span>;
  if (typeof value === 'boolean') return <span className="json-boolean">{String(value)}</span>;
  return <span className="json-primitive">{String(value)}</span>;
}
