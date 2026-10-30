import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { app } from 'electron';
import { encryptSecret, decryptSecret } from '../secret-store.js';

// Credential storage for the cloud client.
//
// The file lives in userData. Every secret in it (refresh token and device
// private key) is ciphertext produced by secret-store (OS keychain-backed
// safeStorage); the device public key is plain, it is public by definition.
// Writes go through a temp file + rename so a crash mid-write cannot leave a
// truncated credential. A missing, unreadable, corrupt, or undecryptable file
// is treated as "signed out" / "no device key" rather than an error.
//
// Signing out removes the session but keeps the device key: workspace keys
// are wrapped to that device public key, so discarding it would make every
// workspace secret unrecoverable after signing back in on the same machine.

const FILE_NAME = 'relay-cloud.json';
const VERSION = 1;

/** Absolute path of the cloud credential file for the current app. */
export function cloudTokenPath() {
  return path.join(app.getPath('userData'), FILE_NAME);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value ? value : '';
}

export function createTokenStore({ filePath = cloudTokenPath() } = {}) {
  // Serialize writes so concurrent set/clear calls cannot interleave their
  // temp-file renames.
  let queue = Promise.resolve();

  /** Parse the file into a plain record; missing/corrupt input yields null. */
  async function readFileRecord() {
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
    return isPlainObject(parsed) ? parsed : null;
  }

  function readDeviceKey(record) {
    const stored = record?.deviceKey;
    if (!isPlainObject(stored)) return null;
    const publicKey = nonEmptyString(stored.publicKey);
    const privateKey = nonEmptyString(stored.privateKey) ? decryptSecret(stored.privateKey) : '';
    if (!publicKey || !privateKey) return null; // undecryptable = no device key
    return { publicKey, privateKey };
  }

  async function writeRecord(record) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    const payload = JSON.stringify(
      {
        ...record,
        version: VERSION,
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

  /** Merge `patch` into the on-disk record, preserving unrelated fields. */
  function updateRecord(patch) {
    return enqueue(async () => {
      const record = { ...(await readFileRecord()) };
      delete record.version;
      delete record.savedAt;
      await writeRecord({ ...record, ...patch });
    });
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
      const record = await readFileRecord();
      return record ? decryptSecret(record.refreshToken) || null : null;
    },

    async getDeviceLabel() {
      const record = await readFileRecord();
      return record?.deviceLabel || null;
    },

    async getDeviceKey() {
      return readDeviceKey(await readFileRecord());
    },

    async set(refreshToken, { deviceLabel = '' } = {}) {
      if (typeof refreshToken !== 'string' || !refreshToken) {
        throw new TypeError('refreshToken is required');
      }
      return updateRecord({
        refreshToken: encryptSecret(refreshToken),
        deviceLabel: typeof deviceLabel === 'string' ? deviceLabel : '',
      });
    },

    async setDeviceKey({ publicKey, privateKey } = {}) {
      if (typeof publicKey !== 'string' || !publicKey) {
        throw new TypeError('publicKey is required');
      }
      if (typeof privateKey !== 'string' || !privateKey) {
        throw new TypeError('privateKey is required');
      }
      return updateRecord({
        deviceKey: {
          publicKey,
          privateKey: encryptSecret(privateKey),
        },
      });
    },

    async clear() {
      return enqueue(async () => {
        const record = await readFileRecord();
        if (isPlainObject(record?.deviceKey)) {
          // Keep the device identity so previously wrapped workspace keys
          // stay recoverable; only the session is discarded.
          await writeRecord({ deviceKey: record.deviceKey });
          return;
        }
        try {
          await fs.rm(filePath, { force: true });
        } catch {
          /* nothing to remove */
        }
      });
    },
  };
}
