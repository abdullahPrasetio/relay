import React, { useState } from 'react';
import Modal from './Modal.jsx';
import MockServerLocalTab from './MockServerLocalTab.jsx';
import MockServerCloudTab from './MockServerCloudTab.jsx';

// One panel, two backends: the existing in-process local server and the
// workspace-scoped server in relay-api. Cloud mocks are not mirrored into the
// workspace JSON; the server stays the source of truth.
export default function MockServerModal({
  store,
  cloud = null,
  remoteWorkspaceId = null,
  onOpenCloud,
  onClose,
}) {
  const [tab, setTab] = useState('local');

  return (
    <Modal title="Mock server" onClose={onClose} width={760}>
      <div className="mock-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'local'}
          className={`mock-tab ${tab === 'local' ? 'active' : ''}`}
          data-testid="mock-tab-local"
          onClick={() => setTab('local')}
        >
          Local
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'cloud'}
          className={`mock-tab ${tab === 'cloud' ? 'active' : ''}`}
          data-testid="mock-tab-cloud"
          onClick={() => setTab('cloud')}
        >
          Cloud
        </button>
      </div>

      {tab === 'local' ? (
        <MockServerLocalTab store={store} />
      ) : (
        <MockServerCloudTab
          workspace={store?.activeWorkspace}
          cloud={cloud}
          remoteWorkspaceId={remoteWorkspaceId}
          onOpenCloud={onOpenCloud}
        />
      )}
    </Modal>
  );
}
