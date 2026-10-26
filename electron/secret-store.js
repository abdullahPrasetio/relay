import { safeStorage } from 'electron';

// Secret storage for proxy passwords and client-cert passphrases.
//
// Electron's safeStorage is the only store we use: secrets are encrypted with
// an OS keychain-backed key. When no real backend is available (e.g. Linux
// falling back to `basic_text`, which is obfuscation, not encryption) we fail
// loudly instead of silently persisting plaintext.

function available() {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (
    process.platform === 'linux' &&
    safeStorage.getSelectedStorageBackend?.() === 'basic_text'
  ) {
    return false;
  }
  return true;
}

/** Encrypt a secret to base64 ciphertext. Empty input yields ''. */
export function encryptSecret(value) {
  if (!value) return '';
  if (!available()) {
    throw new Error('Secure storage is unavailable; cannot persist secrets');
  }
  return safeStorage.encryptString(value).toString('base64');
}

/** Decrypt base64 ciphertext. Any failure degrades to '' (secret unavailable). */
export function decryptSecret(encoded) {
  if (!encoded) return '';
  try {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  } catch {
    return '';
  }
}
