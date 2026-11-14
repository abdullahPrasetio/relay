// macOS custom updater helpers.
//
// electron-updater/Squirrel cannot install an unsigned macOS build. This path
// checks the GitHub release directly, downloads the zip, verifies its SHA-512
// from latest-mac.yml, and hands off to a detached installer script after the
// app quits. Touch ID authorization is handled by Electron in main.js.
//
// The module is intentionally free of Electron imports so the parsing and
// comparison helpers can be unit-tested in plain Node.

import crypto from 'node:crypto';
import fs from 'node:fs';

const REPO = 'abdullahPrasetio/relay';
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
export const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=30`;

export function compareVersions(a, b) {
  const parse = (value) => {
    const clean = String(value || '').replace(/^v/i, '');
    const [core, prerelease = ''] = clean.split('+', 1)[0].split('-', 2);
    return {
      core: core.split('.').map((part) => Number.parseInt(part, 10) || 0),
      prerelease: prerelease ? prerelease.split('.') : [],
    };
  };
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.core.length, right.core.length);
  for (let i = 0; i < length; i += 1) {
    const x = left.core[i] || 0;
    const y = right.core[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const preLength = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < preLength; i += 1) {
    const x = left.prerelease[i];
    const y = right.prerelease[i];
    if (x == null) return -1;
    if (y == null) return 1;
    const nx = Number.parseInt(x, 10);
    const ny = Number.parseInt(y, 10);
    const xNumeric = Number.isFinite(nx) && String(nx) === x;
    const yNumeric = Number.isFinite(ny) && String(ny) === y;
    if (xNumeric && yNumeric && nx !== ny) return nx > ny ? 1 : -1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * Pick the highest non-draft release newer than the running version.
 * Stable ignores prereleases; beta includes both stable and prerelease builds.
 */
export function selectMacRelease(releases, { currentVersion, channel = 'stable' } = {}) {
  const beta = channel === 'beta';
  let best = null;
  for (const release of Array.isArray(releases) ? releases : []) {
    if (!release || release.draft) continue;
    if (!beta && release.prerelease) continue;
    const version = String(release.tag_name || '').replace(/^v/i, '');
    if (!version || compareVersions(version, currentVersion) <= 0) continue;
    if (!best || compareVersions(version, best.version) > 0) {
      best = { release, version };
    }
  }
  return best;
}

// Prefer the zip that matches the running architecture; universal covers both.
export function pickMacAsset(release, arch = process.arch) {
  const zips = (release?.assets || []).filter(
    (asset) => asset?.name?.endsWith('.zip') && asset.name.includes('-mac-')
  );
  if (zips.length === 0) return null;
  const arm = zips.find((asset) => asset.name.includes('-mac-arm64'));
  const universal = zips.find((asset) => asset.name.includes('-mac-universal'));
  const x64 = zips.find((asset) => asset.name.includes('-mac-x64'));
  if (arch === 'arm64') return arm || universal || zips[0];
  return universal || x64 || zips[0];
}

// latest-mac.yml is a small, fixed electron-builder document. Parse only the
// fields this updater needs instead of pulling in a YAML dependency.
export function parseLatestMacYml(text) {
  const result = { version: '', files: [] };
  let current = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const version = line.match(/^version:\s*(.+)$/);
    if (version) {
      result.version = version[1].trim().replace(/^['"]|['"]$/g, '');
      continue;
    }
    if (/^path:/.test(line)) {
      if (current) result.files.push(current);
      current = null;
      continue;
    }
    const url = line.match(/^\s*-\s*url:\s*(.+)$/);
    if (url) {
      if (current) result.files.push(current);
      current = { url: url[1].trim().replace(/^['"]|['"]$/g, '') };
      continue;
    }
    if (!current) continue;
    const sha = line.match(/^\s*sha512:\s*(.+)$/);
    if (sha) {
      current.sha512 = sha[1].trim().replace(/^['"]|['"]$/g, '');
      continue;
    }
    const size = line.match(/^\s*size:\s*(\d+)$/);
    if (size) current.size = Number(size[1]);
  }
  if (current) result.files.push(current);
  return result;
}

export async function checkMacUpdate({
  currentVersion,
  arch = process.arch,
  channel = 'stable',
  fetchImpl = fetch,
} = {}) {
  const beta = channel === 'beta';
  let release;
  if (beta) {
    const response = await fetchImpl(RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Relay-Updater' },
    });
    if (!response.ok) {
      throw new Error(`GitHub release check failed (HTTP ${response.status}).`);
    }
    const releases = await response.json();
    const selected = selectMacRelease(releases, { currentVersion, channel });
    if (!selected) return { available: false, version: currentVersion, channel };
    release = selected.release;
  } else {
    const response = await fetchImpl(LATEST_RELEASE_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Relay-Updater' },
    });
    if (!response.ok) {
      throw new Error(`GitHub release check failed (HTTP ${response.status}).`);
    }
    release = await response.json();
    if (!release || release.draft || release.prerelease) {
      return { available: false, reason: 'no-release', channel };
    }
  }

  const version = String(release.tag_name || '').replace(/^v/i, '');
  if (!version || compareVersions(version, currentVersion) <= 0) {
    return { available: false, version, channel };
  }

  const metaAsset = (release.assets || []).find((asset) => asset.name === 'latest-mac.yml');
  if (!metaAsset?.browser_download_url) {
    throw new Error('latest-mac.yml is missing from the release.');
  }
  const metaResponse = await fetchImpl(metaAsset.browser_download_url, {
    headers: { 'User-Agent': 'Relay-Updater' },
  });
  if (!metaResponse.ok) throw new Error('Could not read latest-mac.yml.');
  const meta = parseLatestMacYml(await metaResponse.text());

  const asset = pickMacAsset(release, arch);
  if (!asset?.browser_download_url) throw new Error('No macOS zip asset found.');
  const file = meta.files.find((entry) => entry.url === asset.name);
  if (!file?.sha512) throw new Error('Update checksum is missing.');

  return {
    available: true,
    version,
    channel,
    prerelease: release.prerelease === true,
    assetName: asset.name,
    url: asset.browser_download_url,
    sha512: file.sha512,
    size: file.size || asset.size || 0,
    releaseUrl: release.html_url || '',
  };
}

export async function downloadToFile(url, destination, { onProgress, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, { headers: { 'User-Agent': 'Relay-Updater' } });
  if (!response.ok) throw new Error(`Update download failed (HTTP ${response.status}).`);
  const total = Number(response.headers.get('content-length')) || 0;
  const stream = fs.createWriteStream(destination);
  let received = 0;
  let failed = false;
  try {
    for await (const chunk of response.body) {
      received += chunk.length;
      if (!stream.write(chunk)) {
        await new Promise((resolve) => stream.once('drain', resolve));
      }
      onProgress?.({
        received,
        total,
        percent: total > 0 ? Math.min(100, (received / total) * 100) : null,
      });
    }
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    await new Promise((resolve, reject) => {
      stream.end((err) => {
        if (err) {
          failed = true;
          reject(err);
          return;
        }
        resolve();
      });
    });
    if (failed) fs.rmSync(destination, { force: true });
  }
  return { size: received };
}

export async function sha512Base64(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512');
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('base64')))
      .on('error', reject);
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// The script survives the app exit: it waits for the old PID, unpacks the zip,
// keeps a backup, swaps the bundle and relaunches. A failed swap restores the
// backup so the user is never left without a working app.
export function buildInstallerScript({ appPath, zipPath, pid }) {
  return `#!/bin/bash
set -u
PID=${Number(pid)}
APP=${shellQuote(appPath)}
ZIP=${shellQuote(zipPath)}
SCRIPT="$0"
BACKUP="\${APP}.relay-backup"
TMP=""
cleanup() {
  if [ -n "$TMP" ]; then /bin/rm -rf "$TMP"; fi
  /bin/rm -f "$ZIP" "$SCRIPT"
}
trap cleanup EXIT
while /bin/kill -0 "$PID" 2>/dev/null; do /bin/sleep 0.5; done
TMP="$(/usr/bin/mktemp -d "\${TMPDIR:-/tmp}/relay-update.XXXXXX")" || exit 1
if ! /usr/bin/ditto -x -k "$ZIP" "$TMP"; then exit 1; fi
NEW_APP="$(/usr/bin/find "$TMP" -maxdepth 1 -name '*.app' -print -quit)"
if [ -z "$NEW_APP" ]; then exit 1; fi
/bin/rm -rf "$BACKUP"
if ! /bin/mv "$APP" "$BACKUP"; then exit 1; fi
if /usr/bin/ditto "$NEW_APP" "$APP"; then
  /usr/bin/xattr -dr com.apple.quarantine "$APP" >/dev/null 2>&1 || true
  /usr/bin/open "$APP"
  /bin/rm -rf "$BACKUP" "$TMP" "$ZIP"
  TMP=""
else
  /bin/rm -rf "$APP"
  /bin/mv "$BACKUP" "$APP"
  /usr/bin/open "$APP"
  exit 1
fi
`;
}


/**
 * Best-effort removal of leftovers from a previous crash. Only old files are
 * touched so an installer that is still running is never deleted.
 */
export function cleanupStaleUpdateFiles(dir, { now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!/^relay-(update|install)-/.test(name)) continue;
    const target = `${dir}/${name}`;
    try {
      const stat = fs.statSync(target);
      if (stat.mtimeMs > now - maxAgeMs) continue;
      fs.rmSync(target, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* best-effort */
    }
  }
  return removed;
}
