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

/**
 * Map an electron-updater event to the small status object the renderer
 * consumes. Keeping this pure makes the event contract testable without
 * importing electron-updater.
 */
export function updateStatus(event, payload = {}) {
  if (event instanceof Error) {
    return { state: 'error', message: describeUpdateEvent(event) };
  }
  const type =
    typeof event === 'object' && event !== null && typeof event.type === 'string'
      ? event.type
      : String(event || '');

  switch (type) {
    case 'checking-for-update':
      return { state: 'checking' };
    case 'update-available':
      return { state: 'available', version: payload.version || null };
    case 'download-progress':
      return {
        state: 'downloading',
        percent: Number.isFinite(Number(payload.percent)) ? Number(payload.percent) : null,
        transferred: Number(payload.transferred) || null,
        total: Number(payload.total) || null,
      };
    case 'update-downloaded':
      return { state: 'ready', version: payload.version || null };
    case 'update-not-available':
      return { state: 'none' };
    case 'error':
      return {
        state: 'error',
        message: describeUpdateEvent(event instanceof Error ? event : 'error', payload),
      };
    default:
      return { state: 'unknown' };
  }
}

/**
 * Wire electron-updater to the release feed.
 *
 * No-op unless the app is packaged (dev runs have no update metadata) and
 * RELAY_DISABLE_UPDATER is not '1' (escape hatch for broken releases).
 * `autoUpdater` is injectable so tests can exercise the wiring without
 * importing electron-updater, and so Electron-only code stays lazy.
 */
export async function initAutoUpdate({ app, autoUpdater, onStatus } = {}) {
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

  // Download in the background. The renderer owns the prompt; installing on
  // quit is opt-in via the "silent update" preference.
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = false;
  const emit = (status) => {
    try {
      onStatus?.(status);
    } catch (err) {
      log(`Could not publish updater status: ${err?.message || err}`);
    }
  };
  // Replace the default logger, which prints full feed URLs.
  updater.logger = {
    info: (message) => log(message),
    warn: (message) => log(message),
    error: (message) => log(message),
    debug: (message) => log(message),
  };

  updater.on('checking-for-update', () => {
    log(describeUpdateEvent('checking-for-update'));
    emit(updateStatus('checking-for-update'));
  });
  updater.on('update-available', (info) => {
    log(describeUpdateEvent('update-available', { version: info?.version }));
    emit(updateStatus('update-available', { version: info?.version }));
  });
  updater.on('download-progress', (progress) => {
    emit(updateStatus('download-progress', progress));
  });
  updater.on('update-not-available', () => {
    log(describeUpdateEvent('update-not-available'));
    emit(updateStatus('update-not-available'));
  });
  updater.on('error', (err) => {
    log(describeUpdateEvent(err));
    emit(updateStatus(err));
  });
  updater.on('update-downloaded', (info) => {
    log(describeUpdateEvent('update-downloaded', { version: info?.version }));
    emit(updateStatus('update-downloaded', { version: info?.version }));
  });

  try {
    // `checkForUpdates` (not `...AndNotify`) keeps all prompting in the app.
    await updater.checkForUpdates();
  } catch (err) {
    // Offline, rate-limited, or unsigned mac builds all land here. Updating is
    // best-effort and must never brick startup.
    log(describeUpdateEvent(err));
  }

  return updater;
}
