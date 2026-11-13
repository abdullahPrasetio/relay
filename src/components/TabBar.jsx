import React, { useState } from 'react';
import Icon from './Icon.jsx';
import ContextMenu from './ContextMenu.jsx';

export default function TabBar({
  tabs,
  activeTabId,
  dashboardTabId = null,
  onSelect,
  onClose,
  onAdd,
  onDuplicate,
  onCloseOthers,
  onCloseAll,
}) {
  const [menu, setMenu] = useState(null); // { tabId, x, y }

  function itemsFor(tab) {
    return [
      { label: 'New Request', onClick: onAdd },
      { label: 'Duplicate Tab', onClick: () => onDuplicate(tab.tabId) },
      { label: 'Close Tab', onClick: () => onClose(tab.tabId) },
      { label: 'Force Close Tab', onClick: () => onClose(tab.tabId, { force: true }) },
      { label: 'Close Other Tabs', onClick: () => onCloseOthers(tab.tabId) },
      { label: 'Close All Tabs', onClick: () => onCloseAll() },
      { label: 'Force Close All Tabs', onClick: () => onCloseAll({ force: true }) },
    ];
  }

  return (
    <div className="tabbar" data-tour="tabs.bar">
      <div className="tabbar-tabs">
        {tabs.map((t) => {
          const isDashboard = t.tabId === dashboardTabId;
          const label = isDashboard
            ? 'Workspace'
            : t.request.name && t.request.name !== 'Untitled Request'
              ? t.request.name
              : t.request.url || 'Untitled Request';
          return (
            <div
              key={t.tabId}
              className={`req-tab ${t.tabId === activeTabId ? 'active' : ''}`}
              onClick={() => onSelect(t.tabId)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setMenu({ tabId: t.tabId, x: e.clientX, y: e.clientY });
              }}
              title={label}
            >
              {isDashboard ? (
                <span className="req-tab-home"><Icon name="workspace" size={13} /></span>
              ) : (
                <span className={`method-tag method-${t.request.method}`}>
                  {t.request.method}
                </span>
              )}
              <span className="req-tab-label">{label}</span>
              {t.dirty && <span className="req-tab-dirty" title="Unsaved changes" />}
              <button
                className="req-tab-close"
                title="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.tabId);
                }}
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          );
        })}
      </div>
      <button className="tabbar-add" data-tour="tabs.new" title="New request tab" onClick={onAdd}>
        <Icon name="plus" size={16} />
      </button>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={itemsFor(tabs.find((t) => t.tabId === menu.tabId) || {})}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
