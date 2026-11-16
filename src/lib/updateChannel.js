// Update channel is a renderer preference. Beta builds default to the beta
// channel so a freshly installed prerelease can see the next prerelease; a
// stable build defaults to stable. An explicit choice always wins.
export const UPDATE_CHANNEL_KEY = 'relay-update-channel';
export const UPDATE_CHANNELS = ['stable', 'beta'];

export function normalizeUpdateChannel(value) {
  return value === 'beta' ? 'beta' : 'stable';
}

export function readUpdateChannel(version = '', storage) {
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  try {
    const stored = store?.getItem(UPDATE_CHANNEL_KEY);
    if (stored === 'stable' || stored === 'beta') return stored;
  } catch {
    /* storage disabled */
  }
  return String(version || '').includes('-') ? 'beta' : 'stable';
}

export function writeUpdateChannel(channel, storage) {
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  const value = normalizeUpdateChannel(channel);
  try {
    store?.setItem(UPDATE_CHANNEL_KEY, value);
    return true;
  } catch {
    return false;
  }
}


/** Ignore a status emitted for another channel (for example a stale beta check). */
export function statusMatchesChannel(status, channel) {
  return !status?.channel || status.channel === channel;
}


/** Compare semver-ish versions; stable sorts after its prereleases. */
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

export function isNewerVersion(candidate, current) {
  return compareVersions(candidate, current) > 0;
}
