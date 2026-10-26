import React from 'react';
import Icon from './Icon.jsx';

export default function TabBar({ tabs, activeTabId, onSelect, onClose, onAdd }) {
  return (
    <div className="tabbar">
      <div className="tabbar-tabs">
        {tabs.map((t) => {
          const label =
            t.request.name && t.request.name !== 'Untitled Request'
              ? t.request.name
              : t.request.url || 'Untitled Request';
          return (
            <div
              key={t.tabId}
              className={`req-tab ${t.tabId === activeTabId ? 'active' : ''}`}
              onClick={() => onSelect(t.tabId)}
              title={label}
            >
              <span className={`method-tag method-${t.request.method}`}>
                {t.request.method}
              </span>
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
      <button className="tabbar-add" title="New request tab" onClick={onAdd}>
        <Icon name="plus" size={16} />
      </button>
    </div>
  );
}
