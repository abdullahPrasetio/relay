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
