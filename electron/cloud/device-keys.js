// Device identity for end-to-end secret sharing (Phase 4.1).
//
// Each installation owns one X25519 key pair. The private key never leaves
// this process: it is persisted encrypted through the token store (safeStorage)
// and only ever used to unwrap workspace keys. The public key is registered
// with relay-api so teammates can wrap workspace keys for this device.
//
// The pair is generated lazily and exactly once per process. When persistence
// fails the pair is *not* cached: a key the server has seen but that cannot
// survive a restart would silently make wrapped workspace keys unrecoverable,
// so the caller gets an error instead.

function isKeyPair(value) {
  return (
    Boolean(value) &&
    typeof value.publicKey === 'string' &&
    value.publicKey.length > 0 &&
    typeof value.privateKey === 'string' &&
    value.privateKey.length > 0
  );
}

/**
 * @param {{ tokenStore: { getDeviceKey: Function, setDeviceKey: Function }, crypto: { generateDeviceKeyPair: Function } }} deps
 */
export function createDeviceKeyManager({ tokenStore, crypto } = {}) {
  if (
    !tokenStore ||
    typeof tokenStore.getDeviceKey !== 'function' ||
    typeof tokenStore.setDeviceKey !== 'function'
  ) {
    throw new TypeError(
      'createDeviceKeyManager requires a tokenStore with getDeviceKey/setDeviceKey'
    );
  }
  if (!crypto || typeof crypto.generateDeviceKeyPair !== 'function') {
    throw new TypeError('createDeviceKeyManager requires a crypto module');
  }

  let cached = null;
  // Shared by concurrent callers so a burst of requests cannot generate two
  // pairs and race their persistence.
  let inFlight = null;

  async function loadOrCreate() {
    if (cached) return cached;
    if (inFlight) return inFlight;

    inFlight = (async () => {
      const stored = await tokenStore.getDeviceKey();
      if (isKeyPair(stored)) {
        cached = { publicKey: stored.publicKey, privateKey: stored.privateKey };
        return cached;
      }

      const generated = crypto.generateDeviceKeyPair();
      if (!isKeyPair(generated)) {
        throw new Error('generateDeviceKeyPair returned an invalid key pair');
      }
      // Persist before caching: an unpersisted private key must never be used
      // to register a public key that outlives it.
      await tokenStore.setDeviceKey({
        publicKey: generated.publicKey,
        privateKey: generated.privateKey,
      });
      cached = { publicKey: generated.publicKey, privateKey: generated.privateKey };
      return cached;
    })().finally(() => {
      inFlight = null;
    });

    return inFlight;
  }

  return { loadOrCreate };
}
