import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { app } from 'electron';
import { encryptSecret, decryptSecret } from '../secret-store.js';

// Refresh-token storage for the cloud client.
//
// The file lives in userData and only ever contains ciphertext produced by
// secret-store (OS keychain-backed safeStorage). Writes go through a temp
// file + rename so a crash mid-write cannot leave a truncated credential.
// A missing, unreadable, corrupt, or undecryptable file is treated as
// "signed out" rather than an error.

const FILE_NAME = 'relay-cloud.json';
const VERSION = 1;

/** Absolute path of the cloud credential file for the current app. */
export function cloudTokenPath() {
  return path.join(app.getPath('userData'), FILE_NAME);
}

export function createTokenStore({ filePath = cloudTokenPath() } = {}) {
  // Serialize writes so concurrent set/clear calls cannot interleave their
  // temp-file renames.
  let queue = Promise.resolve();

  async function readRecord() {
    let raw;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch {
      return null; // missing file = signed out
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null; // corrupt file = signed out
    }
    if (!parsed || typeof parsed !== 'object') return null;

    const token = typeof parsed.refreshToken === 'string' ? decryptSecret(parsed.refreshToken) : '';
    if (!token) return null; // undecryptable ciphertext = signed out

    return {
      refreshToken: token,
      deviceLabel: typeof parsed.deviceLabel === 'string' ? parsed.deviceLabel : '',
    };
  }

  async function writeRecord(refreshToken, label) {
    if (typeof refreshToken !== 'string' || !refreshToken) {
      throw new TypeError('refreshToken is required');
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    const payload = JSON.stringify(
      {
        version: VERSION,
        refreshToken: encryptSecret(refreshToken),
        deviceLabel: typeof label === 'string' ? label : '',
        savedAt: new Date().toISOString(),
      },
      null,
      2
    );
    const temp = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temp, payload, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temp, filePath);
    } catch (err) {
      await fs.rm(temp, { force: true }).catch(() => {});
      throw err;
    }
    try {
      await fs.chmod(filePath, 0o600);
    } catch {
      /* chmod is best effort (e.g. Windows) */
    }
  }

  function enqueue(task) {
    const run = queue.then(task);
    // Keep the queue alive after a failure; the caller still sees the error.
    queue = run.catch(() => {});
    return run;
  }

  return {
    filePath,

    async get() {
      const record = await readRecord();
      return record?.refreshToken || null;
    },

    async getDeviceLabel() {
      const record = await readRecord();
      return record?.deviceLabel || null;
    },

    async set(refreshToken, { deviceLabel = '' } = {}) {
      return enqueue(() => writeRecord(refreshToken, deviceLabel));
    },

    async clear() {
      return enqueue(async () => {
        try {
          await fs.rm(filePath, { force: true });
        } catch {
          /* nothing to remove */
        }
      });
    },
  };
}
