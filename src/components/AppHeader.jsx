import React from 'react';
import WorkspaceSwitcher from './WorkspaceSwitcher.jsx';

// Top application bar: brand, workspace switcher, a centered search field, and
// the signed-in account label. App-level actions live in the activity rail so
// the header stays uncluttered.
export default function AppHeader({ store, cloud, searchQuery, onSearch, onOpenFeatureGuide }) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <span className="brand">
          <span className="brand-dot" />
          Relay
        </span>
        <WorkspaceSwitcher store={store} cloud={cloud} />
      </div>

      <div className="topbar-center">
        <input
          className="global-search"
          data-tour="app.search"
          placeholder="Search requests, collections…"
          value={searchQuery}
          onChange={(e) => onSearch(e.target.value)}
        />
      </div>

      <div className="topbar-right">
        <button
          type="button"
          className="topbar-help"
          data-tour="app.help"
          title="Feature guide"
          aria-label="Feature guide"
          data-testid="feature-guide-open"
          onClick={onOpenFeatureGuide}
        >
          ?
        </button>
        {cloud?.signedIn && (
          <span
            className="cloud-account-email"
            title={cloud.user?.email || 'Relay Cloud'}
            data-testid="cloud-account"
          >
            {cloud.user?.email || cloud.user?.name || 'Relay Cloud'}
          </span>
        )}
      </div>
    </header>
  );
}
