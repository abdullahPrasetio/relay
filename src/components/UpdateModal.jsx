import React from 'react';
import Modal from './Modal.jsx';
import Icon from './Icon.jsx';

// In-app replacement for the native "update ready" message box.
export default function UpdateModal({
  status,
  autoInstall,
  onToggleAutoInstall,
  onInstall,
  onDownload,
  manualDownload = false,
  onLater,
}) {
  const version = status?.version ? ` ${status.version}` : '';
  return (
    <Modal
      title="Update available"
      onClose={onLater}
      width={460}
      footer={
        <>
          <button className="mini-btn" data-testid="update-later" onClick={onLater}>
            Later
          </button>
          {manualDownload ? (
            <button className="send-btn" data-testid="update-download" onClick={onDownload}>
              Download update
            </button>
          ) : (
            <button
              className="send-btn"
              data-testid="update-install"
              onClick={() => onInstall({ silent: true })}
            >
              Restart &amp; install
            </button>
          )}
        </>
      }
    >
      <div className="update-body" data-testid="update-modal">
        <div className="update-hero">
          <Icon name="download" size={26} />
        </div>
        <h3 className="update-title">Relay{version} is ready</h3>
        <p className="auth-hint">
          {manualDownload
            ? 'Download the latest macOS build, then open the DMG and replace Relay. Auto-install requires a signed and notarized build.'
            : 'The update has been downloaded. Restart now to finish installing, or keep working and it will be applied later.'}
        </p>
        {!manualDownload && (
          <>
            <label className="settings-check update-auto">
              <input
                type="checkbox"
                data-testid="update-auto-install"
                checked={autoInstall}
                onChange={(e) => onToggleAutoInstall(e.target.checked)}
              />
              Install automatically when I quit
            </label>
            {autoInstall && (
              <p className="auth-hint" data-testid="update-auto-hint">
                Silent update is on: Relay will install the update when you quit, without
                showing the installer.
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
