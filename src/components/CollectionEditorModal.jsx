import React, { useState } from 'react';
import Modal from './Modal.jsx';
import KeyValueEditor from './KeyValueEditor.jsx';
import AuthPanel from './AuthPanel.jsx';

// Collection-level editor, echoing Postman's collection tabs:
// Overview (description), Authorization, Variables, Scripts.
// Auth and scripts here are inherited by requests inside the collection.
const TABS = ['Overview', 'Authorization', 'Variables', 'Scripts'];

export default function CollectionEditorModal({ collection, onClose, onChange }) {
  const [tab, setTab] = useState('Overview');
  const patch = (p) => onChange({ ...collection, ...p });

  return (
    <Modal title={`Collection · ${collection.name}`} onClose={onClose} width={680}>
      <div className="tabs" style={{ marginBottom: 12 }}>
        {TABS.map((t) => (
          <button
            key={t}
            className={`tab ${tab === t ? 'active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t}
            {t === 'Authorization' && collection.auth?.type && collection.auth.type !== 'none' && (
              <span className="dot" />
            )}
            {t === 'Variables' && (collection.variables?.length || 0) > 0 && (
              <span className="badge">{collection.variables.length}</span>
            )}
            {t === 'Scripts' && (collection.preRequest?.trim() || collection.tests?.trim()) && (
              <span className="dot" />
            )}
          </button>
        ))}
      </div>

      {tab === 'Overview' && (
        <div className="form-row">
          <label>Description</label>
          <textarea
            className="body-text"
            style={{ minHeight: 140 }}
            placeholder="Describe what this collection is for…"
            value={collection.description || ''}
            onChange={(e) => patch({ description: e.target.value })}
          />
          <label
            style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}
          >
            <input
              type="checkbox"
              checked={collection.scriptsTrusted !== false}
              onChange={(e) => patch({ scriptsTrusted: e.target.checked })}
            />
            Trust scripts in this collection
          </label>
          <p className="auth-hint">
            Imported collections start untrusted so their scripts never run without
            permission.
          </p>
        </div>
      )}

      {tab === 'Authorization' && (
        <>
          <p className="auth-hint" style={{ marginTop: 0 }}>
            Requests set to “Inherit auth from parent” use this.
          </p>
          <AuthPanel
            auth={normalizeCollectionAuth(collection.auth)}
            onChange={(auth) => patch({ auth })}
          />
        </>
      )}

      {tab === 'Variables' && (
        <>
          <KeyValueEditor
            rows={collection.variables || []}
            onChange={(variables) => patch({ variables })}
            keyPlaceholder="Variable"
            showType
          />
          <p className="auth-hint">
            Reference with <code>{'{{name}}'}</code>. The active environment overrides these.
          </p>
        </>
      )}

      {tab === 'Scripts' && (
        <>
          <div className="form-row">
            <label>Pre-request (runs before every request in this collection)</label>
            <textarea
              className="body-text"
              style={{ minHeight: 110 }}
              spellCheck={false}
              placeholder={`pm.collectionVariables.set("ranAt", Date.now());`}
              value={collection.preRequest || ''}
              onChange={(e) => patch({ preRequest: e.target.value })}
            />
          </div>
          <div className="form-row">
            <label>Tests (runs after every request in this collection)</label>
            <textarea
              className="body-text"
              style={{ minHeight: 110 }}
              spellCheck={false}
              placeholder={`pm.test("no server error", function () {\n  pm.expect(pm.response.code).to.be.below(500);\n});`}
              value={collection.tests || ''}
              onChange={(e) => patch({ tests: e.target.value })}
            />
          </div>
        </>
      )}
    </Modal>
  );
}

// Collections cannot "inherit"; coerce any stray inherit to none for the UI.
function normalizeCollectionAuth(auth) {
  const a = auth || { type: 'none' };
  return a.type === 'inherit' ? { ...a, type: 'none' } : a;
}
