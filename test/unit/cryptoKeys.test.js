import {
  createCipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CRYPTO_DECRYPT,
  CRYPTO_INVALID,
  SECRET_ENVELOPE_VERSION,
  WORKSPACE_KEY_BYTES,
  WRAPPED_KEY_BYTES,
  CryptoError,
  decryptSecretValue,
  encryptSecretValue,
  fromBase64,
  generateDeviceKeyPair,
  generateWorkspaceKey,
  toBase64,
  unwrapWorkspaceKey,
  wrapWorkspaceKey,
} from '../../packages/core/src/crypto/index.js';

const WRAP_INFO = Buffer.from('relay-workspace-key-v1', 'utf8');

function expectCode(fn, code) {
  let caught;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(CryptoError);
  expect(caught.code).toBe(code);
  return caught;
}

/** Build a wrapped-key envelope by hand so tests can vary the AAD. */
function manualWrap({ workspaceKey, recipientPublicKey, aad, salt = recipientPublicKey }) {
  const eph = generateKeyPairSync('x25519');
  const ephemeralPublic = Buffer.from(eph.publicKey.export({ format: 'jwk' }).x, 'base64url');
  const recipientKey = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), fromBase64(recipientPublicKey)]),
    format: 'der',
    type: 'spki',
  });
  const ecdh = diffieHellman({ privateKey: eph.privateKey, publicKey: recipientKey });
  const aesKey = Buffer.from(hkdfSync('sha256', ecdh, salt, WRAP_INFO, 32));
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(workspaceKey),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return toBase64(Buffer.concat([ephemeralPublic, nonce, ciphertext]));
}

describe('X25519 workspace key wrapping', () => {
  it('round-trips a workspace key for two different recipients', () => {
    const workspaceKey = generateWorkspaceKey();
    const alice = generateDeviceKeyPair();
    const bob = generateDeviceKeyPair();

    const forAlice = wrapWorkspaceKey({ workspaceKey, recipientPublicKey: alice.publicKey });
    const forBob = wrapWorkspaceKey({ workspaceKey, recipientPublicKey: bob.publicKey });

    expect(unwrapWorkspaceKey({ wrappedKey: forAlice, privateKey: alice.privateKey })).toEqual(
      workspaceKey,
    );
    expect(unwrapWorkspaceKey({ wrappedKey: forBob, privateKey: bob.privateKey })).toEqual(
      workspaceKey,
    );
    expect(forAlice).not.toBe(forBob);
  });

  it('fails with ERR_CRYPTO_DECRYPT for the wrong private key', () => {
    const workspaceKey = generateWorkspaceKey();
    const alice = generateDeviceKeyPair();
    const mallory = generateDeviceKeyPair();
    const wrapped = wrapWorkspaceKey({ workspaceKey, recipientPublicKey: alice.publicKey });

    const err = expectCode(
      () => unwrapWorkspaceKey({ wrappedKey: wrapped, privateKey: mallory.privateKey }),
      CRYPTO_DECRYPT,
    );
    expect(err.message).not.toContain(alice.privateKey);
    expect(err.message).not.toContain(toBase64(workspaceKey));
  });

  it('fails when the ephemeral public key, nonce, ciphertext, or tag is tampered with', () => {
    const workspaceKey = generateWorkspaceKey();
    const alice = generateDeviceKeyPair();
    const wrapped = wrapWorkspaceKey({ workspaceKey, recipientPublicKey: alice.publicKey });
    const raw = fromBase64(wrapped);
    expect(raw.length).toBe(WRAPPED_KEY_BYTES);

    // One byte in each envelope segment: ephemeral pub, nonce, ciphertext, tag.
    for (const offset of [0, 32, 44, raw.length - 1]) {
      const tampered = Buffer.from(raw);
      tampered[offset] ^= 0x01;
      expectCode(
        () => unwrapWorkspaceKey({ wrappedKey: toBase64(tampered), privateKey: alice.privateKey }),
        CRYPTO_DECRYPT,
      );
    }
  });

  it('binds the ciphertext to the recipient public key via GCM AAD', () => {
    const workspaceKey = generateWorkspaceKey();
    const alice = generateDeviceKeyPair();
    const bob = generateDeviceKeyPair();
    const wrongAad = fromBase64(bob.publicKey);

    const wrapped = manualWrap({
      workspaceKey,
      recipientPublicKey: alice.publicKey,
      aad: wrongAad,
    });

    expectCode(
      () => unwrapWorkspaceKey({ wrappedKey: wrapped, privateKey: alice.privateKey }),
      CRYPTO_DECRYPT,
    );
  });

  it('fails with ERR_CRYPTO_DECRYPT for a low-order ephemeral key', () => {
    const workspaceKey = generateWorkspaceKey();
    const alice = generateDeviceKeyPair();
    const wrapped = wrapWorkspaceKey({ workspaceKey, recipientPublicKey: alice.publicKey });
    const raw = fromBase64(wrapped);

    const zeroEphemeral = Buffer.from(raw);
    zeroEphemeral.fill(0, 0, 32);
    expectCode(
      () =>
        unwrapWorkspaceKey({
          wrappedKey: toBase64(zeroEphemeral),
          privateKey: alice.privateKey,
        }),
      CRYPTO_DECRYPT,
    );
  });

  it('produces a base64 envelope that decodes to exactly 92 bytes and hides the key', () => {
    const workspaceKey = generateWorkspaceKey();
    const alice = generateDeviceKeyPair();
    const wrapped = wrapWorkspaceKey({ workspaceKey, recipientPublicKey: alice.publicKey });
    const raw = fromBase64(wrapped);

    expect(WRAPPED_KEY_BYTES).toBe(92);
    expect(raw.length).toBe(92);
    expect(wrapped).not.toContain(toBase64(workspaceKey));
    expect(wrapped).not.toContain(workspaceKey.toString('hex'));
    expect(raw.indexOf(workspaceKey)).toBe(-1);
    // Randomized per wrap (fresh ephemeral key + nonce).
    expect(wrapWorkspaceKey({ workspaceKey, recipientPublicKey: alice.publicKey })).not.toBe(
      wrapped,
    );
  });

  it('rejects malformed inputs with ERR_CRYPTO_INVALID', () => {
    const alice = generateDeviceKeyPair();
    const workspaceKey = generateWorkspaceKey();
    const wrapped = wrapWorkspaceKey({ workspaceKey, recipientPublicKey: alice.publicKey });

    expectCode(() => wrapWorkspaceKey(), CRYPTO_INVALID);
    expectCode(
      () => wrapWorkspaceKey({ workspaceKey: Buffer.alloc(31), recipientPublicKey: alice.publicKey }),
      CRYPTO_INVALID,
    );
    expectCode(
      () => wrapWorkspaceKey({ workspaceKey, recipientPublicKey: 'not base64!!' }),
      CRYPTO_INVALID,
    );
    expectCode(
      () => wrapWorkspaceKey({ workspaceKey, recipientPublicKey: toBase64(Buffer.alloc(31)) }),
      CRYPTO_INVALID,
    );
    expectCode(
      () => wrapWorkspaceKey({ workspaceKey, recipientPublicKey: toBase64(Buffer.alloc(32)) }),
      CRYPTO_INVALID,
    );
    expectCode(() => unwrapWorkspaceKey({ wrappedKey: 'AAAA', privateKey: alice.privateKey }), CRYPTO_INVALID);
    expectCode(
      () => unwrapWorkspaceKey({ wrappedKey: wrapped, privateKey: toBase64(Buffer.alloc(16)) }),
      CRYPTO_INVALID,
    );
  });
});

describe('device key pairs', () => {
  it('encodes raw 32-byte X25519 keys as stable base64', () => {
    const first = generateDeviceKeyPair();
    const second = generateDeviceKeyPair();

    for (const key of [first, second]) {
      expect(fromBase64(key.publicKey)).toHaveLength(WORKSPACE_KEY_BYTES);
      expect(fromBase64(key.privateKey)).toHaveLength(WORKSPACE_KEY_BYTES);
      expect(toBase64(fromBase64(key.publicKey))).toBe(key.publicKey);
      expect(toBase64(fromBase64(key.privateKey))).toBe(key.privateKey);
    }
    expect(first.publicKey).not.toBe(second.publicKey);
    expect(first.privateKey).not.toBe(second.privateKey);
    expect(first.publicKey).not.toBe(first.privateKey);
  });

  it('pairs wrap with unwrap across regeneration boundaries', () => {
    const workspaceKey = generateWorkspaceKey();
    const device = generateDeviceKeyPair();
    const wrapped = wrapWorkspaceKey({ workspaceKey, recipientPublicKey: device.publicKey });

    // Encoding/decoding the same key material must still unwrap.
    const reencoded = {
      publicKey: toBase64(fromBase64(device.publicKey)),
      privateKey: toBase64(fromBase64(device.privateKey)),
    };
    expect(unwrapWorkspaceKey({ wrappedKey: wrapped, privateKey: reencoded.privateKey })).toEqual(
      workspaceKey,
    );
  });
});

describe('secret value encryption', () => {
  it('round-trips strings including unicode and the empty string', () => {
    const workspaceKey = generateWorkspaceKey();
    const samples = ['hello world', 'pässwörd 🔐 你好\nsecond line', '', '{"json":true}'];

    for (const plaintext of samples) {
      const envelope = encryptSecretValue(workspaceKey, plaintext);
      const parsed = JSON.parse(envelope);
      expect(parsed.v).toBe(SECRET_ENVELOPE_VERSION);
      expect(fromBase64(parsed.n)).toHaveLength(12);
      if (plaintext) expect(envelope).not.toContain(plaintext);
      expect(decryptSecretValue(workspaceKey, envelope)).toBe(plaintext);
    }
  });

  it('uses a fresh nonce for every encryption', () => {
    const workspaceKey = generateWorkspaceKey();
    const a = JSON.parse(encryptSecretValue(workspaceKey, 'same'));
    const b = JSON.parse(encryptSecretValue(workspaceKey, 'same'));
    expect(a.n).not.toBe(b.n);
    expect(a.d).not.toBe(b.d);
  });

  it('fails with ERR_CRYPTO_DECRYPT for a wrong workspace key', () => {
    const workspaceKey = generateWorkspaceKey();
    const otherKey = generateWorkspaceKey();
    const envelope = encryptSecretValue(workspaceKey, 'top secret');

    expectCode(() => decryptSecretValue(otherKey, envelope), CRYPTO_DECRYPT);
  });

  it('fails with ERR_CRYPTO_DECRYPT for tampered nonce or ciphertext', () => {
    const workspaceKey = generateWorkspaceKey();
    const envelope = encryptSecretValue(workspaceKey, 'top secret');
    const parsed = JSON.parse(envelope);

    for (const field of ['n', 'd']) {
      const tampered = Buffer.from(fromBase64(parsed[field]));
      tampered[0] ^= 0x01;
      expectCode(
        () => decryptSecretValue(workspaceKey, JSON.stringify({ ...parsed, [field]: toBase64(tampered) })),
        CRYPTO_DECRYPT,
      );
    }
  });

  it('binds the version via GCM AAD and rejects unknown versions', () => {
    const workspaceKey = generateWorkspaceKey();
    const envelope = encryptSecretValue(workspaceKey, 'v-bound');
    const parsed = JSON.parse(envelope);

    expectCode(
      () => decryptSecretValue(workspaceKey, JSON.stringify({ ...parsed, v: 2 })),
      CRYPTO_INVALID,
    );

    // Same ciphertext, same nonce, but produced with a v2 AAD.
    const nonce = fromBase64(parsed.n);
    const ciphertext = fromBase64(parsed.d);
    const cipher = createCipheriv('aes-256-gcm', workspaceKey, nonce);
    cipher.setAAD(Buffer.from('relay-secret-value:v2', 'utf8'));
    const v2Ciphertext = Buffer.concat([
      cipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    expectCode(
      () =>
        decryptSecretValue(
          workspaceKey,
          JSON.stringify({ v: 1, n: parsed.n, d: toBase64(v2Ciphertext) }),
        ),
      CRYPTO_DECRYPT,
    );
  });

  it('rejects malformed envelopes with ERR_CRYPTO_INVALID', () => {
    const workspaceKey = generateWorkspaceKey();
    const valid = encryptSecretValue(workspaceKey, 'x');
    const parsed = JSON.parse(valid);

    expectCode(() => decryptSecretValue(Buffer.alloc(31), valid), CRYPTO_INVALID);
    expectCode(() => encryptSecretValue(workspaceKey, 42), CRYPTO_INVALID);
    expectCode(() => decryptSecretValue(workspaceKey, 'not json'), CRYPTO_INVALID);
    expectCode(() => decryptSecretValue(workspaceKey, 'null'), CRYPTO_INVALID);
    expectCode(() => decryptSecretValue(workspaceKey, '[]'), CRYPTO_INVALID);
    expectCode(
      () => decryptSecretValue(workspaceKey, JSON.stringify({ ...parsed, n: 'AAAA' })),
      CRYPTO_INVALID,
    );
    expectCode(
      () => decryptSecretValue(workspaceKey, JSON.stringify({ ...parsed, d: 'AAAA' })),
      CRYPTO_INVALID,
    );
    expectCode(
      () => decryptSecretValue(workspaceKey, JSON.stringify({ ...parsed, v: '1' })),
      CRYPTO_INVALID,
    );
  });
});
