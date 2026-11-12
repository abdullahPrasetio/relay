import React, { useState } from 'react';
import Modal from './Modal.jsx';
import Icon from './Icon.jsx';

function statusLabel(status) {
  switch (status?.state) {
    case 'checking':
      return 'Checking for updates…';
    case 'available':
      return `Update ${status.version || ''} available.`.trim();
    case 'downloading':
      return status.percent == null
        ? 'Downloading update…'
        : `Downloading update… ${Math.round(status.percent)}%`;
    case 'ready':
      return `Update ${status.version || ''} ready to install.`.trim();
    case 'none':
      return 'You are running the latest version.';
    case 'error':
      return status.message || 'Update check failed.';
    default:
      return 'Not checked yet.';
  }
}

export default function UpdateCheckModal({
  version,
  status,
  platform,
  autoInstall,
  onToggleAutoInstall,
  onInstall,
  onMacInstall,
  installing = false,
  progress = null,
  installError = '',
  onClose,
}) {
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState('');
  const isMac = platform === 'darwin';
  const ready = status?.state === 'ready' || (isMac && status?.state === 'available');

  async function check() {
    const api = typeof window !== 'undefined' ? window.api : null;
    if (!api?.checkForUpdates) {
      setCheckError('Update checks require the desktop app.');
      return;
    }
    setChecking(true);
    setCheckError('');
    try {
      const result = await api.checkForUpdates();
      if (!result?.ok) setCheckError(result?.error || 'Could not check for updates.');
    } catch (err) {
      setCheckError(err?.message || String(err));
    } finally {
      setChecking(false);
    }
  }

  const error = installError || checkError;

  return (
    <Modal
      title="Updates"
      onClose={onClose}
      width={460}
      footer={
        <>
          <button className="mini-btn" data-testid="update-close" onClick={onClose}>
            Close
          </button>
          <button
            className="mini-btn"
            data-testid="update-check"
            onClick={check}
            disabled={checking || status?.state === 'checking'}
          >
            {checking || status?.state === 'checking' ? 'Checking…' : 'Check for updates'}
          </button>
          {ready &&
            (isMac ? (
              <button
                className="send-btn"
                data-testid="update-install"
                onClick={onMacInstall}
                disabled={installing}
              >
                {installing ? 'Installing…' : 'Install update'}
              </button>
            ) : (
              <button
                className="send-btn"
                data-testid="update-install"
                onClick={() => onInstall({ silent: true })}
              >
                Restart &amp; install
              </button>
            ))}
        </>
      }
    >
      <div className="update-body" data-testid="update-check-modal">
        <div className="update-hero">
          <Icon name="download" size={26} />
        </div>
        <h3 className="update-title">Relay {version || '…'}</h3>
        <p className="auth-hint" data-testid="update-check-status">
          {statusLabel(status)}
        </p>
        {(progress?.percent != null || status?.state === 'downloading') && (
          <div className="update-progress" data-testid="update-progress">
            <div
              style={{
                width: `${Math.max(
                  0,
                  Math.min(100, progress?.percent ?? status?.percent ?? 0)
                )}%`,
              }}
            />
          </div>
        )}
        {!isMac && (
          <label className="settings-check update-auto">
            <input
              type="checkbox"
              data-testid="update-auto-install"
              checked={autoInstall}
              onChange={(e) => onToggleAutoInstall(e.target.checked)}
            />
            Install automatically when I quit
          </label>
        )}
        {error && (
          <p className="auth-hint settings-error" data-testid="update-error">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
