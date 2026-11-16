import { describe, expect, it } from 'vitest';
import {
  UPDATE_CHANNEL_KEY,
  isNewerVersion,
  normalizeUpdateChannel,
  readUpdateChannel,
  statusMatchesChannel,
  writeUpdateChannel,
} from '../../src/lib/updateChannel.js';

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    map,
  };
}

describe('update channel preference', () => {
  it('defaults prerelease builds to beta and stable builds to stable', () => {
    expect(readUpdateChannel('0.28.0-beta.1', memoryStorage())).toBe('beta');
    expect(readUpdateChannel('0.28.0', memoryStorage())).toBe('stable');
  });

  it('lets an explicit choice win over the build default', () => {
    const storage = memoryStorage({ [UPDATE_CHANNEL_KEY]: 'stable' });
    expect(readUpdateChannel('0.28.0-beta.1', storage)).toBe('stable');
    const beta = memoryStorage({ [UPDATE_CHANNEL_KEY]: 'beta' });
    expect(readUpdateChannel('0.28.0', beta)).toBe('beta');
  });

  it('detects newer versions and stable-over-prerelease ordering', () => {
    expect(isNewerVersion('0.30.0-beta.3', '0.30.0-beta.2')).toBe(true);
    expect(isNewerVersion('0.29.0', '0.30.0-beta.2')).toBe(false);
    expect(isNewerVersion('0.30.0', '0.30.0-beta.2')).toBe(true);
    expect(isNewerVersion('0.30.0-beta.2', '0.30.0-beta.2')).toBe(false);
  });

  it('ignores statuses emitted for another channel', () => {
    expect(statusMatchesChannel({ state: 'available', channel: 'beta' }, 'stable')).toBe(false);
    expect(statusMatchesChannel({ state: 'available', channel: 'beta' }, 'beta')).toBe(true);
    expect(statusMatchesChannel({ state: 'none' }, 'stable')).toBe(true);
    expect(statusMatchesChannel(null, 'stable')).toBe(true);
  });

  it('normalizes and persists unknown values as stable', () => {
    const storage = memoryStorage();
    expect(normalizeUpdateChannel('nightly')).toBe('stable');
    expect(writeUpdateChannel('beta', storage)).toBe(true);
    expect(storage.getItem(UPDATE_CHANNEL_KEY)).toBe('beta');
    expect(writeUpdateChannel('nightly', storage)).toBe(true);
    expect(storage.getItem(UPDATE_CHANNEL_KEY)).toBe('stable');
  });
});
