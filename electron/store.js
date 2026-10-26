import fs from 'node:fs';

// The renderer owns the workspace-shaped app data; the main process only
// additionally manages the cookie jar. EMPTY just guarantees cookieJar exists.
const EMPTY = {
  cookieJar: [],
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
      // Preserve the cookie jar across renderer saves (the renderer store
      // doesn't manage it; the main process does).
      const jar = next.cookieJar != null ? next.cookieJar : data.cookieJar;
      data = { ...EMPTY, ...next, cookieJar: jar || [] };
      persist();
    },
    getCookieJar() {
      return data.cookieJar || [];
    },
    setCookieJar(jar) {
      data.cookieJar = jar || [];
      persist();
    },
  };
}
