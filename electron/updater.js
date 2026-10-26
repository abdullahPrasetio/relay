// Auto-update wiring, kept out of main.js so the pure decisions stay testable
// in plain Node (no Electron import at module load).
//
// Feed: GitHub Releases, declared as `build.publish` in package.json.
// electron-builder writes `latest-mac.yml`, `latest.yml`, and
// `latest-linux.yml` next to the installers when publishing (`--publish
// always`); electron-updater reads those files, not the release page HTML.
//
// macOS caveat: Squirrel.Mac only updates a signed app. An unsigned/ad-hoc
// build will download the update and then fail to install it. Signing and
// notarization are prerequisites for auto-update on macOS. See RELEASING.md.
//
// This module MUST stay free of top-level Electron/electron-updater imports:
// unit tests import it in plain Node and only exercise the pure helpers.

const SUPPORTED_PLATFORMS = new Set(['darwin', 'win32', 'linux']);

// URLs can carry signed tokens (private-repo downloads, redirects). Logs are
// visible in packaged builds, so strip anything URL-shaped before printing.
const URL_PATTERN = /https?:\/\/\S+/g;

function redact(value) {
  return String(value ?? '').replace(URL_PATTERN, '<url>');
}

function log(message) {
  console.log(`[updater] ${redact(message)}`);
}

/** Whether this build should talk to the release feed at all. */
export function shouldCheckForUpdates({
  isPackaged = false,
  disabled = false,
  platform = process.platform,
} = {}) {
  if (!isPackaged) return false;
  if (disabled) return false;
  return SUPPORTED_PLATFORMS.has(platform);
}

/**
 * Human-readable, URL-free description of an updater event. Accepts the
 * electron-updater event name (with an optional payload) or an Error.
 */
export function describeUpdateEvent(event, payload = {}) {
  if (event instanceof Error) {
    return `Update error: ${redact(event.message || 'unknown error')}`;
  }

  if (typeof event === 'object' && event !== null) {
    if (event.type === 'error' || event.error instanceof Error) {
      const err = event.error instanceof Error ? event.error : event;
      return `Update error: ${redact(err.message || 'unknown error')}`;
    }
    if (typeof event.type === 'string') {
      return describeUpdateEvent(event.type, { ...event, ...payload });
    }
    return 'Update event: unknown';
  }

  const type = String(event || '');
  switch (type) {
    case 'checking-for-update':
      return 'Checking for updates…';
    case 'update-available':
      return payload.version ? `Update ${payload.version} is available` : 'Update available';
    case 'update-not-available':
      return 'You are running the latest version';
    case 'update-downloaded':
      return payload.version
        ? `Update ${payload.version} downloaded; restart to install`
        : 'Update downloaded; restart to install';
    case 'download-progress':
      return 'Downloading update…';
    case 'error':
      return `Update error: ${redact(payload.error?.message || payload.message || 'unknown error')}`;
    default:
      return 'Update event: unknown';
  }
}

/** Native dialog options for the "update ready" prompt. */
export function updatePrompt({ version, detail } = {}) {
  return {
    type: 'info',
    buttons: ['Restart to update', 'Later'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: 'Update ready',
    message: version
      ? `Relay ${version} is ready to install.`
      : 'An update is ready to install.',
    detail: detail || 'Relay will restart to finish installing the update.',
  };
}

/**
 * Wire electron-updater to the release feed.
 *
 * No-op unless the app is packaged (dev runs have no update metadata) and
 * RELAY_DISABLE_UPDATER is not '1' (escape hatch for broken releases).
 * `autoUpdater` is injectable so tests can exercise the wiring without
 * importing electron-updater, and so Electron-only code stays lazy.
 */
export async function initAutoUpdate({ app, dialog, autoUpdater } = {}) {
  if (!app) return null;

  const disabled = process.env.RELAY_DISABLE_UPDATER === '1';
  if (!shouldCheckForUpdates({ isPackaged: app.isPackaged, disabled })) return null;

  let updater = autoUpdater;
  if (!updater) {
    try {
      ({ autoUpdater: updater } = await import('electron-updater'));
    } catch (err) {
      log(`Could not load electron-updater: ${err?.message || err}`);
      return null;
    }
  }

  // Download in the background; the prompt only offers "Restart" vs "Later".
  updater.autoDownload = true;
  // Replace the default logger, which prints full feed URLs.
  updater.logger = {
    info: (message) => log(message),
    warn: (message) => log(message),
    error: (message) => log(message),
    debug: (message) => log(message),
  };

  updater.on('checking-for-update', () => log(describeUpdateEvent('checking-for-update')));
  updater.on('update-available', (info) =>
    log(describeUpdateEvent('update-available', { version: info?.version }))
  );
  updater.on('update-not-available', () => log(describeUpdateEvent('update-not-available')));
  updater.on('error', (err) => log(describeUpdateEvent(err)));

  updater.on('update-downloaded', async (info) => {
    log(describeUpdateEvent('update-downloaded', { version: info?.version }));
    if (!dialog?.showMessageBox) return;
    try {
      const result = await dialog.showMessageBox(updatePrompt({ version: info?.version }));
      if (result?.response === 0) updater.quitAndInstall();
    } catch (err) {
      log(`Could not show update prompt: ${err?.message || err}`);
    }
  });

  try {
    await updater.checkForUpdatesAndNotify();
  } catch (err) {
    // Offline, rate-limited, or unsigned mac builds all land here. Updating is
    // best-effort and must never brick startup.
    log(describeUpdateEvent(err));
  }

  return updater;
}
