import React, { useEffect, useState } from 'react';
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
  channel = 'stable',
  onChangeChannel,
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
  const [localStatus, setLocalStatus] = useState(null);
  const isMac = platform === 'darwin';
  const displayStatus = localStatus || status;
  const ready =
    displayStatus?.state === 'ready' || (isMac && displayStatus?.state === 'available');

  useEffect(() => {
    setLocalStatus(null);
    setCheckError('');
  }, [channel]);

  async function check() {
    const api = typeof window !== 'undefined' ? window.api : null;
    if (!api?.checkForUpdates) {
      setCheckError('Update checks require the desktop app.');
      return;
    }
    setChecking(true);
    setCheckError('');
    try {
      if (isMac && api.macCheckUpdate) {
        const result = await api.macCheckUpdate({ channel });
        if (!result?.ok) {
          setCheckError(result?.error || 'Could not check for updates.');
        } else {
          setLocalStatus(
            result.data?.available
              ? { state: 'available', version: result.data.version }
              : { state: 'none', version: result.data?.version }
          );
        }
      } else {
        const result = await api.checkForUpdates({ channel });
        if (!result?.ok) setCheckError(result?.error || 'Could not check for updates.');
      }
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
            disabled={checking || displayStatus?.state === 'checking'}
          >
            {checking || displayStatus?.state === 'checking' ? 'Checking…' : 'Check for updates'}
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
          {statusLabel(displayStatus)}
        </p>
        {(progress?.percent != null || displayStatus?.state === 'downloading') && (
          <div className="update-progress" data-testid="update-progress">
            <div
              style={{
                width: `${Math.max(
                  0,
                  Math.min(100, progress?.percent ?? displayStatus?.percent ?? 0)
                )}%`,
              }}
            />
          </div>
        )}
        <label className="settings-check update-channel">
          <span>Update channel</span>
          <select
            data-testid="update-channel"
            value={channel}
            onChange={(event) => onChangeChannel?.(event.target.value)}
          >
            <option value="stable">Stable</option>
            <option value="beta">Beta</option>
          </select>
        </label>
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
