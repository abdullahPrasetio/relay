import React from 'react';
import EnvBar from './EnvBar.jsx';
import WorkspaceSwitcher from './WorkspaceSwitcher.jsx';
import Icon from './Icon.jsx';

// Top application bar: brand, a centered (decorative) search field, and the
// environment selector on the right -- echoing Postman's header layout.
export default function AppHeader({
  store,
  searchQuery,
  onSearch,
  onOpenCookies,
  onOpenMock,
  onOpenSettings,
  onOpenAppearance,
}) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <span className="brand">
          <span className="brand-dot" />
          Relay
        </span>
        <WorkspaceSwitcher store={store} />
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
