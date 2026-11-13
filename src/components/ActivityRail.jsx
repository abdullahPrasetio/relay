import React from 'react';
import Icon from './Icon.jsx';

// The vertical icon rail on the far left. The top group switches the sidebar's
// active panel; the bottom group holds app-level actions (cloud, devices,
// cookies, mock, support, appearance, settings).
const ITEMS = [
  { id: 'collections', label: 'Collections', icon: 'collection' },
  { id: 'environments', label: 'Environments', icon: 'globe' },
  { id: 'history', label: 'History', icon: 'clock' },
  { id: 'docs', label: 'Docs', icon: 'file' },
];

function syncTitle(cloud) {
  if (!cloud?.signedIn) return 'Sign in to Relay Cloud';
  if (cloud.status === 'local') return 'This workspace is not linked to Relay Cloud';
  return `${cloud.status || 'local'}${cloud.user?.email ? ` — ${cloud.user.email}` : ''}`;
}

export default function ActivityRail({
  active,
  onSelect,
  cloud,
  onOpenCloud,
  onOpenDevices,
  onOpenCookies,
  onOpenMock,
  onOpenDonation,
  onOpenAppearance,
  onOpenSettings,
  onOpenUpdate,
  updateStatus,
}) {
  const updateState = updateStatus?.state || 'idle';
  const updateTone =
    updateState === 'available' || updateState === 'ready' || updateState === 'error'
      ? 'alert'
      : updateState === 'downloading' || updateState === 'checking'
        ? 'busy'
        : '';
  const updateTitle =
    updateState === 'available' || updateState === 'ready'
      ? `Update ${updateStatus?.version || ''} available`.trim()
      : updateState === 'downloading'
        ? 'Downloading update…'
        : updateState === 'checking'
          ? 'Checking for updates…'
          : updateState === 'error'
            ? 'Update check failed'
            : 'Check for updates';
  return (
    <nav className="activity-rail">
      <div className="rail-group">
        {ITEMS.map((it) => (
          <button
            key={it.id}
            className={`rail-item ${active === it.id ? 'active' : ''}`}
            title={it.label}
            onClick={() => onSelect(it.id)}
            data-testid={`rail-${it.id}`}
          >
            <Icon name={it.icon} size={20} />
            <span className="rail-label">{it.label}</span>
          </button>
        ))}
      </div>

      <div className="rail-actions">
        {cloud && (
          <button
            type="button"
            className={`rail-action sync-${cloud.status || 'local'}${cloud.signedIn ? ' signed-in' : ''}`}
            title={syncTitle(cloud)}
            aria-label={syncTitle(cloud)}
            onClick={onOpenCloud}
            data-testid="cloud-status"
            data-state={cloud.status || 'local'}
          >
            <Icon name="cloud" size={16} />
            <span className="rail-dot" aria-hidden="true" />
          </button>
        )}
        {cloud?.signedIn && (
          <button
            type="button"
            className="rail-action"
            onClick={onOpenDevices}
            title="Devices"
            aria-label="Devices"
            data-testid="devices-open"
          >
            <Icon name="monitor" size={16} />
          </button>
        )}
        <button
          type="button"
          className="rail-action"
          onClick={onOpenCookies}
          title="Cookies"
          aria-label="Cookies"
          data-testid="cookies-open"
        >
          <Icon name="cookie" size={16} />
        </button>
        <button
          type="button"
          className="rail-action"
          onClick={onOpenMock}
          title="Mock server"
          aria-label="Mock server"
          data-testid="mock-open"
        >
          <Icon name="globe" size={16} />
        </button>
        <button
          type="button"
          className="rail-action donation-btn"
          onClick={onOpenDonation}
          title="Support Relay"
          aria-label="Support Relay"
          data-testid="donation-open"
        >
          <Icon name="heart" size={16} />
        </button>
        <button
          type="button"
          className="rail-action"
          onClick={onOpenAppearance}
          title="Appearance"
          aria-label="Appearance"
          data-testid="appearance-open"
        >
          <Icon name="palette" size={16} />
        </button>
        <button
          type="button"
          className={`rail-action update-action ${updateTone}`}
          onClick={onOpenUpdate}
          title={updateTitle}
          aria-label={updateTitle}
          data-testid="update-open"
          data-state={updateState}
        >
          <Icon name="download" size={16} />
          <span className="rail-dot" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="rail-action"
          onClick={onOpenSettings}
          title="Settings"
          aria-label="Settings"
          data-testid="settings-open"
        >
          <Icon name="gear" size={16} />
        </button>
      </div>
    </nav>
  );
}
