// Crypto surface for end-to-end secret sharing (Phase 4.1).
export {
  CryptoError,
  CRYPTO_DECRYPT,
  CRYPTO_INVALID,
  SECRET_ENVELOPE_VERSION,
  WORKSPACE_KEY_BYTES,
  WRAPPED_KEY_BYTES,
  generateDeviceKeyPair,
  generateWorkspaceKey,
  wrapWorkspaceKey,
  unwrapWorkspaceKey,
  encryptSecretValue,
  decryptSecretValue,
  toBase64,
  fromBase64,
} from './keys.js';
