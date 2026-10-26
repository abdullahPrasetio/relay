import React, { useState } from 'react';
import Modal from './Modal.jsx';
import { listFolders } from '../lib/collectionTree.js';

// Dialog to name a request and choose a destination collection + folder.
export default function SaveRequestModal({ request, collections, onCancel, onSave }) {
  const [name, setName] = useState(
    request.name && request.name !== 'Untitled Request' ? request.name : request.url || ''
  );
  const [collectionId, setCollectionId] = useState(collections[0]?.id || '');
  const [folderId, setFolderId] = useState('');

  const collection = collections.find((c) => c.id === collectionId);
  const folders = collection ? listFolders(collection) : [];

  function submit() {
    if (!collectionId) return; // Save button is disabled in this case
    onSave({
      name: name.trim() || 'Untitled Request',
      collectionId,
      folderId: folderId || null,
    });
  }

  return (
    <Modal
      title="Save Request"
      onClose={onCancel}
      footer={
        <>
          <button className="mini-btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="send-btn" onClick={submit} disabled={!collectionId}>
            Save
          </button>
        </>
      }
    >
      <div className="form-row">
        <label>Request name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <div className="form-row">
        <label>Collection</label>
        <select
          value={collectionId}
          onChange={(e) => {
            setCollectionId(e.target.value);
            setFolderId('');
          }}
        >
          {collections.length === 0 && <option value="">No collections</option>}
          {collections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {collections.length === 0 && (
          <p className="auth-hint" style={{ color: 'var(--red)' }}>
            Create a collection first (sidebar → “+ New”).
          </p>
        )}
      </div>
      <div className="form-row">
        <label>Folder</label>
        <select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
          {folders.map((f) => (
            <option key={f.id || 'root'} value={f.id || ''}>
              {'\u00A0'.repeat(f.depth * 2)}
              {f.depth === 0 ? `${f.name} (root)` : f.name}
            </option>
          ))}
        </select>
      </div>
    </Modal>
  );
}
