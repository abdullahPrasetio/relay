import React from 'react';
import Icon from './Icon.jsx';

// The vertical icon rail on the far left. Switches the sidebar's active panel.
const ITEMS = [
  { id: 'collections', label: 'Collections', icon: 'collection' },
  { id: 'environments', label: 'Environments', icon: 'globe' },
  { id: 'history', label: 'History', icon: 'clock' },
];

export default function ActivityRail({ active, onSelect }) {
  return (
    <nav className="activity-rail">
      {ITEMS.map((it) => (
        <button
          key={it.id}
          className={`rail-item ${active === it.id ? 'active' : ''}`}
          title={it.label}
          onClick={() => onSelect(it.id)}
        >
          <Icon name={it.icon} size={20} />
          <span className="rail-label">{it.label}</span>
        </button>
      ))}
    </nav>
  );
}
