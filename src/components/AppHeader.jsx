import React from 'react';
import EnvBar from './EnvBar.jsx';
import WorkspaceSwitcher from './WorkspaceSwitcher.jsx';
import Icon from './Icon.jsx';

// Top application bar: brand, a centered (decorative) search field, and the
// environment selector on the right -- echoing Postman's header layout.
const SYNC_LABELS = {
  local: 'Local only',
  synced: 'Synced',
  syncing: 'Syncing…',
  offline: 'Offline',
  conflict: 'Conflict',
  signed_out: 'Signed out',
};

export default function AppHeader({
  store,
  cloud,
  searchQuery,
  onSearch,
  onOpenCookies,
  onOpenMock,
  onOpenSettings,
  onOpenAppearance,
  onOpenCloud,
  onOpenDevices,
}) {
  const syncStatus = cloud?.status || 'local';
  const syncLabel = SYNC_LABELS[syncStatus] || 'Local only';
  const syncTitle = !cloud?.signedIn
    ? 'Sign in to Relay Cloud'
    : syncStatus === 'local'
      ? 'This workspace is not linked to Relay Cloud'
      : `${syncLabel}${cloud.user?.email ? ` — ${cloud.user.email}` : ''}`;

  function handleCloudClick() {
    if (!cloud) return;
    if (!cloud.signedIn) {
      onOpenCloud?.();
      return;
    }
    cloud.syncNow?.();
  }

  return (
    <header className="topbar">
      <div className="topbar-left">
        <span className="brand">
          <span className="brand-dot" />
          Relay
        </span>
        <WorkspaceSwitcher store={store} cloud={cloud} onOpenCloud={onOpenCloud} />
      </div>

      <div className="topbar-center">
        <input
          className="global-search"
          placeholder="Search requests, collections…"
          value={searchQuery}
          onChange={(e) => onSearch(e.target.value)}
        />
      </div>

      <div className="topbar-right">
        {cloud && (
          <button
            type="button"
            className={`sync-pill sync-${syncStatus}`}
            title={syncTitle}
            onClick={handleCloudClick}
            data-testid="cloud-status"
          >
            <span className="sync-dot" aria-hidden="true" />
            {syncLabel}
          </button>
        )}
        {cloud && (
          <button
            type="button"
            className="mini-btn icon-only"
            onClick={onOpenDevices}
            title="Devices"
            aria-label="Devices"
            data-testid="devices-open"
          >
            <Icon name="monitor" size={15} />
          </button>
        )}
        <EnvBar
          environments={store.environments}
          activeEnvId={store.activeEnvId}
          onSelect={store.setActiveEnvId}
          onChange={store.setEnvironments}
          globals={store.globals}
          onChangeGlobals={store.setGlobals}
        />
        <span className="topbar-divider" aria-hidden="true" />
        <button
          className="mini-btn icon-only"
          onClick={onOpenCookies}
          title="Cookies"
          aria-label="Cookies"
          data-testid="cookies-open"
        >
          <Icon name="cookie" size={15} />
        </button>
        <button
          className="mini-btn icon-only"
          onClick={onOpenMock}
          title="Mock server"
          aria-label="Mock server"
          data-testid="mock-open"
        >
          <Icon name="globe" size={15} />
        </button>
        <button
          className="mini-btn icon-only"
          onClick={onOpenAppearance}
          title="Appearance"
          aria-label="Appearance"
          data-testid="appearance-open"
        >
          <Icon name="palette" size={15} />
        </button>
        <button
          className="mini-btn icon-only"
          onClick={onOpenSettings}
          title="Network settings"
          aria-label="Network settings"
          data-testid="settings-open"
        >
          <Icon name="gear" size={15} />
        </button>
      </div>
    </header>
  );
}
