import fs from 'node:fs';
import { DEFAULT_NETWORK_SETTINGS } from '../shared/networkSettings.js';

// The renderer owns the workspace-shaped app data; the main process owns the
// cookie jar and the network settings. EMPTY guarantees those keys exist.
const EMPTY = {
  cookieJar: [],
  network: DEFAULT_NETWORK_SETTINGS,
};

/**
 * Tiny JSON-file backed store held in the main process. Keeping app data
 * here (not in the renderer) mirrors how Postman isolates persistence from
 * the UI layer.
 */
export function createStore(filePath) {
  let data = load();

  function load() {
    // Try the main file; if it's missing or corrupt, fall back to the backup.
    for (const candidate of [filePath, filePath + '.bak']) {
      try {
        const text = fs.readFileSync(candidate, 'utf8');
        const parsed = JSON.parse(text);
        if (candidate !== filePath) {
          console.warn('Main data file unreadable; recovered from backup.');
        }
        return { ...EMPTY, ...parsed };
      } catch {
        /* try next candidate */
      }
    }
    return { ...EMPTY };
  }

  function persist() {
    // Atomic write: serialize to a temp file, then rename over the real file.
    // Rename is atomic on the same filesystem, so a crash mid-write can never
    // leave a half-written (corrupt) data file. We also keep a .bak of the
    // previous good copy as a safety net.
    const tmp = filePath + '.tmp';
    const bak = filePath + '.bak';
    try {
      const serialized = JSON.stringify(data, null, 2);
      fs.writeFileSync(tmp, serialized, 'utf8');
      // Preserve the previous good file as a backup before replacing it.
      if (fs.existsSync(filePath)) {
        try {
          fs.copyFileSync(filePath, bak);
        } catch {
          /* backup is best-effort */
        }
      }
      fs.renameSync(tmp, filePath); // atomic replace
    } catch (err) {
      console.error('Failed to persist store:', err.message);
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }

  return {
    getAll() {
      return data;
    },
    setAll(next) {
      // Preserve main-process-owned fields across renderer saves (the renderer
      // store manages neither the cookie jar nor the network settings).
      const jar = next.cookieJar != null ? next.cookieJar : data.cookieJar;
      const network = next.network != null ? next.network : data.network;
      data = { ...EMPTY, ...next, cookieJar: jar || [], network: network || DEFAULT_NETWORK_SETTINGS };
      persist();
    },
    getCookieJar() {
      return data.cookieJar || [];
    },
    setCookieJar(jar) {
      data.cookieJar = jar || [];
      persist();
    },
    getNetworkSettings() {
      return data.network || DEFAULT_NETWORK_SETTINGS;
    },
    setNetworkSettings(network) {
      data.network = network || DEFAULT_NETWORK_SETTINGS;
      persist();
    },
    // One-time safety copy of the data file, e.g. before a schema migration.
    // Never overwrites an existing backup; returns null when there is nothing
    // to copy (fresh install) or the copy failed.
    backup(tag) {
      if (!fs.existsSync(filePath)) return null;
      const target = `${filePath}.${tag}.bak`;
      if (fs.existsSync(target)) return target;
      try {
        fs.copyFileSync(filePath, target);
        return target;
      } catch {
        return null;
      }
    },
  };
}
