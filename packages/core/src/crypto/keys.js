// Workspace-key and secret-value cryptography (Phase 4.1).
//
// Threat model: the relay backend only ever stores wrapped workspace keys and
// opaque secret envelopes. A workspace key is generated on a device and wrapped
// once per recipient device with X25519 ECDH + HKDF-SHA256 + AES-256-GCM, so
// only the holder of a recipient device private key can recover it.
//
// Wrapped-key envelope (binary, 92 bytes before base64):
//
//   ephemeral public key (32) || nonce (12) || ciphertext + GCM tag (48)
//
// The ciphertext is always 32 bytes of workspace key plus the 16-byte tag.
// HKDF salt is the recipient public key (32 bytes); HKDF info is
// "relay-workspace-key-v1"; AES-GCM AAD is the recipient public key, which binds
// the ciphertext to the intended device.
//
// Secret-value envelope (stored as a JSON string):
//
//   { "v": 1, "n": "<base64 nonce>", "d": "<base64 ciphertext+tag>" }
//
// AES-256-GCM AAD is "relay-secret-value:v1", which binds the format version.
//
// This module uses node:crypto only and never logs or embeds key material in
// error messages.

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

/** Raw X25519 key length in bytes. */
export const WORKSPACE_KEY_BYTES = 32;
/** Serialized wrapped-key envelope length in bytes. */
export const WRAPPED_KEY_BYTES = 92;
/** Current secret-value envelope version. */
export const SECRET_ENVELOPE_VERSION = 1;

export const CRYPTO_INVALID = 'ERR_CRYPTO_INVALID';
export const CRYPTO_DECRYPT = 'ERR_CRYPTO_DECRYPT';

/** Typed crypto failure: `code` is stable, `message` never contains key material. */
export class CryptoError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CryptoError';
    this.code = code;
  }
}

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const EPHEMERAL_PUBLIC_BYTES = 32;
const WRAP_CIPHERTEXT_BYTES = WORKSPACE_KEY_BYTES + TAG_BYTES;

// DER prefixes for raw X25519 keys (RFC 8410, OID 1.3.101.110).
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

const WRAP_INFO = Buffer.from('relay-workspace-key-v1', 'utf8');
const SECRET_AAD_PREFIX = 'relay-secret-value:v';

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function invalid(message) {
  return new CryptoError(CRYPTO_INVALID, message);
}

function decryptFailed(message) {
  return new CryptoError(CRYPTO_DECRYPT, message);
}

/** Encode bytes as standard padded base64. */
export function toBase64(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw invalid('expected bytes');
  }
  return Buffer.from(bytes).toString('base64');
}

/** Decode standard padded base64 into a Buffer, rejecting malformed input. */
export function fromBase64(value, label = 'value') {
  if (typeof value !== 'string') throw invalid(`${label} must be a base64 string`);
  const text = value.trim();
  if (!text || text.length % 4 !== 0 || !BASE64_RE.test(text)) {
    throw invalid(`${label} is not valid base64`);
  }
  const bytes = Buffer.from(text, 'base64');
  // Node tolerates non-canonical encodings; require an exact round-trip.
  if (bytes.toString('base64') !== text) throw invalid(`${label} is not valid base64`);
  return bytes;
}

function asBytes(value, label) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw invalid(`${label} must be bytes`);
}

function requireByteLength(bytes, length, label) {
  if (bytes.length !== length) throw invalid(`${label} must be ${length} bytes`);
  return bytes;
}

function base64UrlToBuffer(value) {
  return Buffer.from(value, 'base64url');
}

function importPrivateKey(raw) {
  const der = Buffer.concat([X25519_PKCS8_PREFIX, raw]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

function importPublicKey(raw) {
  const der = Buffer.concat([X25519_SPKI_PREFIX, raw]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

function exportRawPublicKey(keyObject) {
  const jwk = keyObject.export({ format: 'jwk' });
  return base64UrlToBuffer(jwk.x);
}

function hkdfAesKey(sharedSecret, salt) {
  const out = hkdfSync('sha256', sharedSecret, salt, WRAP_INFO, 32);
  return Buffer.from(out);
}

/** Generate a fresh 32-byte workspace key. */
export function generateWorkspaceKey() {
  return randomBytes(WORKSPACE_KEY_BYTES);
}

/**
 * Generate an X25519 device key pair encoded as raw 32-byte base64 values.
 * @returns {{ publicKey: string, privateKey: string }}
 */
export function generateDeviceKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: toBase64(exportRawPublicKey(publicKey)),
    privateKey: toBase64(base64UrlToBuffer(privateKey.export({ format: 'jwk' }).d)),
  };
}

/**
 * Wrap a workspace key for one recipient device.
 * @param {{ workspaceKey: Buffer|Uint8Array, recipientPublicKey: string }} input
 * @returns {string} base64 envelope (92 bytes decoded)
 */
export function wrapWorkspaceKey({ workspaceKey, recipientPublicKey } = {}) {
  const key = requireByteLength(
    asBytes(workspaceKey, 'workspaceKey'),
    WORKSPACE_KEY_BYTES,
    'workspaceKey',
  );
  const recipient = requireByteLength(
    fromBase64(recipientPublicKey, 'recipientPublicKey'),
    EPHEMERAL_PUBLIC_BYTES,
    'recipientPublicKey',
  );

  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralPublic = exportRawPublicKey(ephemeral.publicKey);
  let sharedSecret;
  try {
    sharedSecret = diffieHellman({
      privateKey: ephemeral.privateKey,
      publicKey: importPublicKey(recipient),
    });
  } catch {
    // Structurally valid DER can still encode a low-order/zero point.
    throw invalid('recipientPublicKey is not a usable X25519 public key');
  }
  const aesKey = hkdfAesKey(sharedSecret, recipient);
  const nonce = randomBytes(NONCE_BYTES);

  let ciphertext;
  try {
    const cipher = createCipheriv('aes-256-gcm', aesKey, nonce);
    cipher.setAAD(recipient);
    ciphertext = Buffer.concat([cipher.update(key), cipher.final(), cipher.getAuthTag()]);
  } finally {
    sharedSecret.fill(0);
    aesKey.fill(0);
  }

  const envelope = Buffer.concat([ephemeralPublic, nonce, ciphertext]);
  if (envelope.length !== WRAPPED_KEY_BYTES) {
    throw invalid('wrapped key envelope has an unexpected size');
  }
  return toBase64(envelope);
}

/**
 * Recover a workspace key from a wrapped-key envelope.
 * @param {{ wrappedKey: string, privateKey: string }} input
 * @returns {Buffer} 32-byte workspace key
 */
export function unwrapWorkspaceKey({ wrappedKey, privateKey } = {}) {
  const envelope = fromBase64(wrappedKey, 'wrappedKey');
  if (envelope.length !== WRAPPED_KEY_BYTES) {
    throw invalid(`wrappedKey must be ${WRAPPED_KEY_BYTES} bytes`);
  }
  const rawPrivate = requireByteLength(
    fromBase64(privateKey, 'privateKey'),
    WORKSPACE_KEY_BYTES,
    'privateKey',
  );

  const ephemeralPublic = envelope.subarray(0, EPHEMERAL_PUBLIC_BYTES);
  const nonce = envelope.subarray(
    EPHEMERAL_PUBLIC_BYTES,
    EPHEMERAL_PUBLIC_BYTES + NONCE_BYTES,
  );
  const ciphertext = envelope.subarray(EPHEMERAL_PUBLIC_BYTES + NONCE_BYTES);
  if (ciphertext.length !== WRAP_CIPHERTEXT_BYTES) {
    throw invalid('wrappedKey ciphertext has an unexpected size');
  }

  const privateKeyObject = importPrivateKey(rawPrivate);
  const recipientPublic = exportRawPublicKey(createPublicKey(privateKeyObject));
  let sharedSecret;
  try {
    sharedSecret = diffieHellman({
      privateKey: privateKeyObject,
      publicKey: importPublicKey(ephemeralPublic),
    });
  } catch {
    throw decryptFailed('workspace key could not be decrypted');
  }
  const aesKey = hkdfAesKey(sharedSecret, recipientPublic);

  let plaintext;
  try {
    const decipher = createDecipheriv('aes-256-gcm', aesKey, nonce);
    decipher.setAAD(recipientPublic);
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_BYTES));
    plaintext = Buffer.concat([
      decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    throw decryptFailed('workspace key could not be decrypted');
  } finally {
    sharedSecret.fill(0);
    aesKey.fill(0);
  }

  if (plaintext.length !== WORKSPACE_KEY_BYTES) {
    throw decryptFailed('workspace key has an unexpected size');
  }
  return plaintext;
}

function secretAad(version) {
  return Buffer.from(`${SECRET_AAD_PREFIX}${version}`, 'utf8');
}

/**
 * Encrypt a secret value with the workspace key.
 * @param {Buffer|Uint8Array} workspaceKey 32-byte workspace key
 * @param {string} plaintext
 * @returns {string} JSON envelope `{ v: 1, n, d }`
 */
export function encryptSecretValue(workspaceKey, plaintext) {
  const key = requireByteLength(
    asBytes(workspaceKey, 'workspaceKey'),
    WORKSPACE_KEY_BYTES,
    'workspaceKey',
  );
  if (typeof plaintext !== 'string') throw invalid('plaintext must be a string');

  const version = SECRET_ENVELOPE_VERSION;
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(secretAad(version));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  return JSON.stringify({
    v: version,
    n: toBase64(nonce),
    d: toBase64(ciphertext),
  });
}

/**
 * Decrypt a secret-value envelope produced by {@link encryptSecretValue}.
 * @param {Buffer|Uint8Array} workspaceKey 32-byte workspace key
 * @param {string} envelope JSON envelope
 * @returns {string} plaintext
 */
export function decryptSecretValue(workspaceKey, envelope) {
  const key = requireByteLength(
    asBytes(workspaceKey, 'workspaceKey'),
    WORKSPACE_KEY_BYTES,
    'workspaceKey',
  );
  if (typeof envelope !== 'string') throw invalid('secret envelope must be a JSON string');

  let parsed;
  try {
    parsed = JSON.parse(envelope);
  } catch {
    throw invalid('secret envelope is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalid('secret envelope must be an object');
  }
  if (parsed.v !== SECRET_ENVELOPE_VERSION) {
    throw invalid('unsupported secret envelope version');
  }

  const nonce = requireByteLength(fromBase64(parsed.n, 'nonce'), NONCE_BYTES, 'nonce');
  const ciphertext = fromBase64(parsed.d, 'ciphertext');
  if (ciphertext.length < TAG_BYTES) throw invalid('ciphertext is too short');

  const plaintext = (() => {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(secretAad(parsed.v));
      decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_BYTES));
      return Buffer.concat([
        decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_BYTES)),
        decipher.final(),
      ]);
    } catch {
      throw decryptFailed('secret value could not be decrypted');
    }
  })();

  return plaintext.toString('utf8');
}
