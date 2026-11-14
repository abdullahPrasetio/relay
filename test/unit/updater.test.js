import { describe, expect, it } from 'vitest';
import {
  describeUpdateEvent,
  initAutoUpdate,
  shouldCheckForUpdates,
  updateStatus,
} from '../../electron/updater.js';

describe('shouldCheckForUpdates', () => {
  it('never checks in development builds', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      expect(shouldCheckForUpdates({ isPackaged: false, disabled: false, platform })).toBe(false);
    }
  });

  it('checks in packaged builds on supported platforms', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      expect(shouldCheckForUpdates({ isPackaged: true, disabled: false, platform })).toBe(true);
    }
  });

  it('respects the RELAY_DISABLE_UPDATER escape hatch', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      expect(shouldCheckForUpdates({ isPackaged: true, disabled: true, platform })).toBe(false);
    }
  });

  it('rejects unsupported platforms', () => {
    expect(shouldCheckForUpdates({ isPackaged: true, disabled: false, platform: 'freebsd' })).toBe(
      false
    );
  });

  it('defaults to not checking when called without arguments', () => {
    expect(shouldCheckForUpdates()).toBe(false);
  });
});

describe('describeUpdateEvent', () => {
  it('describes each known event without leaking URLs', () => {
    expect(describeUpdateEvent('checking-for-update')).toBe('Checking for updates…');
    expect(describeUpdateEvent('update-available', { version: '1.2.3' })).toBe(
      'Update 1.2.3 is available'
    );
    expect(describeUpdateEvent('update-not-available')).toBe('You are running the latest version');
    expect(describeUpdateEvent('update-downloaded', { version: '1.2.3' })).toBe(
      'Update 1.2.3 downloaded; restart to install'
    );
    expect(describeUpdateEvent('download-progress')).toBe('Downloading update…');
  });

  it('falls back when a version is missing', () => {
    expect(describeUpdateEvent('update-available')).toBe('Update available');
    expect(describeUpdateEvent('update-downloaded')).toBe('Update downloaded; restart to install');
  });

  it('describes Error objects and redacts URL-shaped text', () => {
    const message = describeUpdateEvent(
      new Error('request to https://api.github.com/repos/x/y/token?abc=1 failed')
    );
    expect(message).toBe('Update error: request to <url> failed');
  });

  it('describes plain error payloads and error event objects', () => {
    expect(describeUpdateEvent('error', { message: 'network down' })).toBe(
      'Update error: network down'
    );
    expect(describeUpdateEvent({ type: 'error', message: 'boom' })).toBe('Update error: boom');
    expect(describeUpdateEvent({ error: new Error('boom') })).toBe('Update error: boom');
    expect(describeUpdateEvent('error')).toBe('Update error: unknown error');
  });

  it('handles object-shaped known events', () => {
    expect(describeUpdateEvent({ type: 'update-available', version: '2.0.0' })).toBe(
      'Update 2.0.0 is available'
    );
  });

  it('returns a generic description for unknown or empty events', () => {
    expect(describeUpdateEvent('something-new')).toBe('Update event: unknown');
    expect(describeUpdateEvent({ foo: 'bar' })).toBe('Update event: unknown');
    expect(describeUpdateEvent(null)).toBe('Update event: unknown');
    expect(describeUpdateEvent(undefined)).toBe('Update event: unknown');
  });
});

describe('updateStatus', () => {
  it('maps updater events to renderer states', () => {
    expect(updateStatus('checking-for-update')).toEqual({ state: 'checking' });
    expect(updateStatus('update-available', { version: '1.2.3' })).toEqual({
      state: 'available',
      version: '1.2.3',
    });
    expect(updateStatus('download-progress', { percent: 42.4, transferred: 10, total: 20 })).toEqual({
      state: 'downloading',
      percent: 42.4,
      transferred: 10,
      total: 20,
    });
    expect(updateStatus('update-downloaded', { version: '1.2.3' })).toEqual({
      state: 'ready',
      version: '1.2.3',
    });
    expect(updateStatus('update-not-available')).toEqual({ state: 'none' });
  });

  it('reports errors without leaking URLs', () => {
    const status = updateStatus(new Error('failed at https://api.github.com/x?token=1'));
    expect(status.state).toBe('error');
    expect(status.message).toBe('Update error: failed at <url>');
    expect(status.message).not.toMatch(/https?:\/\//);
  });
});

describe('initAutoUpdate', () => {
  it('is a no-op without an app or when the build is not packaged', async () => {
    const updater = { on() {}, autoDownload: false, checkForUpdates() {} };

    await expect(initAutoUpdate()).resolves.toBeNull();
    await expect(
      initAutoUpdate({ app: { isPackaged: false }, autoUpdater: updater })
    ).resolves.toBeNull();
    expect(updater.autoDownload).toBe(false);
  });

  it('enables prerelease updates on the beta channel', async () => {
    const updater = {
      on() {},
      autoDownload: false,
      allowPrerelease: false,
      channel: 'latest',
      async checkForUpdates() {},
    };
    await initAutoUpdate({
      app: { isPackaged: true },
      autoUpdater: updater,
      channel: 'beta',
    });
    expect(updater.allowPrerelease).toBe(true);
    expect(updater.channel).toBe('beta');
    await initAutoUpdate({ app: { isPackaged: true }, autoUpdater: updater, channel: 'stable' });
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.channel).toBe('latest');
  });

  it('publishes statuses and leaves install-on-quit opt-in', async () => {
    const listeners = {};
    const statuses = [];
    const updater = {
      on(event, cb) {
        listeners[event] = cb;
      },
      autoDownload: false,
      autoInstallOnAppQuit: true,
      async checkForUpdates() {},
      quitAndInstall() {},
    };

    const instance = await initAutoUpdate({
      app: { isPackaged: true },
      autoUpdater: updater,
      onStatus: (status) => statuses.push(status),
    });

    expect(instance).toBe(updater);
    expect(updater.autoDownload).toBe(process.platform !== 'darwin');
    expect(updater.autoInstallOnAppQuit).toBe(false);
    listeners['update-available']({ version: '2.0.0' });
    listeners['update-downloaded']({ version: '2.0.0' });
    expect(statuses).toEqual([
      { state: 'available', version: '2.0.0' },
      { state: 'ready', version: '2.0.0' },
    ]);
  });
});
