import React from 'react';
import EnvBar from './EnvBar.jsx';
import WorkspaceSwitcher from './WorkspaceSwitcher.jsx';
import Icon from './Icon.jsx';

// Top application bar: brand, a centered (decorative) search field, and the
// environment selector on the right -- echoing Postman's header layout.
export default function AppHeader({ store, searchQuery, onSearch, onOpenCookies }) {
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
        <button className="mini-btn icon-text" onClick={onOpenCookies} title="View stored cookies">
          <Icon name="cookie" size={14} /> Cookies
        </button>
        <EnvBar
          environments={store.environments}
          activeEnvId={store.activeEnvId}
          onSelect={store.setActiveEnvId}
          onChange={store.setEnvironments}
          globals={store.globals}
          onChangeGlobals={store.setGlobals}
        />
      </div>
    </header>
  );
}
