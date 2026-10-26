import { describe, expect, it } from 'vitest';
import {
  describeUpdateEvent,
  initAutoUpdate,
  shouldCheckForUpdates,
  updatePrompt,
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

describe('updatePrompt', () => {
  it('offers restart or later, with restart as the default', () => {
    const options = updatePrompt({ version: '1.2.3' });
    expect(options.buttons).toEqual(['Restart to update', 'Later']);
    expect(options.defaultId).toBe(0);
    expect(options.cancelId).toBe(1);
    expect(options.noLink).toBe(true);
    expect(options.message).toBe('Relay 1.2.3 is ready to install.');
    expect(options.detail).toContain('restart');
  });

  it('works without a version and contains no URLs or credentials', () => {
    const options = updatePrompt();
    expect(options.message).toBe('An update is ready to install.');
    const serialized = JSON.stringify(options);
    expect(serialized).not.toMatch(/https?:\/\//);
    expect(serialized).not.toMatch(/token|password|secret/i);
  });
});

describe('initAutoUpdate', () => {
  it('is a no-op without an app or when the build is not packaged', async () => {
    const updater = { on() {}, autoDownload: false, checkForUpdatesAndNotify() {} };

    await expect(initAutoUpdate()).resolves.toBeNull();
    await expect(
      initAutoUpdate({ app: { isPackaged: false }, dialog: {}, autoUpdater: updater })
    ).resolves.toBeNull();
    expect(updater.autoDownload).toBe(false);
  });
});
