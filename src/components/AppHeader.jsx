import React from 'react';
import WorkspaceSwitcher from './WorkspaceSwitcher.jsx';

// Top application bar: brand, workspace switcher, a centered search field, and
// the signed-in account label. App-level actions live in the activity rail so
// the header stays uncluttered.
export default function AppHeader({ store, cloud, searchQuery, onSearch }) {
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
          placeholder="Search requests, collections…"
          value={searchQuery}
          onChange={(e) => onSearch(e.target.value)}
        />
      </div>

      <div className="topbar-right">
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
