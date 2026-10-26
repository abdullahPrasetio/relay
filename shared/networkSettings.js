// Network settings contract shared by the main process and the renderer.
//
// Pure module: no Electron, no Node, no DOM. The renderer uses it to run in
// browser mode (no bridge) and both sides use it to normalize persisted data
// so a corrupt or stale settings blob can never crash a request.

export const DEFAULT_NETWORK_SETTINGS = Object.freeze({
  proxyMode: 'none', // 'none' | 'environment' | 'manual'
  activeProxyId: null,
  proxies: [],
  timeoutMs: 30000,
  followRedirects: true,
  maxRedirects: 5,
  verifyTls: true,
  maxResponseBytes: 52428800, // 50 MB
  customCaPath: '',
  clientCertPath: '',
  clientKeyPath: '',
  // Optional SNI override; empty = use the request URL's hostname.
  servername: '',
  // Encrypted client-cert passphrase (safeStorage ciphertext, base64). The
  // renderer never sees this field; sanitizeNetworkSettings drops it.
  clientCertPassphraseEnc: '',
});

const PROXY_MODES = ['none', 'environment', 'manual'];
const PROXY_PROTOCOLS = ['http', 'https', 'socks5'];
const BYPASS_SEPARATORS = /[,\n]+/;

function randomId() {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `px_${uuid}`;
}

function toInt(raw, min, max, fallback) {
  const n = typeof raw === 'number' ? raw : parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function toBool(raw, fallback) {
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
}

function toStr(raw) {
  return typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
}

function normalizeBypass(raw) {
  const list = Array.isArray(raw) ? raw : toStr(raw).split(BYPASS_SEPARATORS);
  return list
    .map((entry) => toStr(entry).trim())
    .filter(Boolean);
}

function normalizeProxy(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const protocol = PROXY_PROTOCOLS.includes(p.protocol) ? p.protocol : 'http';
  return {
    id: toStr(p.id).trim() || randomId(),
    name: toStr(p.name).trim() || 'Proxy',
    protocol,
    host: toStr(p.host).trim(),
    port: toInt(p.port, 1, 65535, protocol === 'socks5' ? 1080 : 8080),
    username: toStr(p.username),
    bypass: normalizeBypass(p.bypass),
    // Ciphertext only: plaintext `password` is handled (encrypted) by the main
    // process before this function ever sees the settings.
    passwordEnc: toStr(p.passwordEnc),
    // Presence flag used by the sanitized renderer view. It survives a
    // normalize(sanitize(x)) round-trip even though the ciphertext does not.
    hasPassword: toBool(p.hasPassword, false),
  };
}

/**
 * Coerce arbitrary persisted/user input into the canonical settings shape.
 * Never throws, never keeps plaintext secrets.
 */
export function normalizeNetworkSettings(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};

  const proxies = (Array.isArray(d.proxies) ? d.proxies : []).map(normalizeProxy);
  const requestedActive = toStr(d.activeProxyId).trim();
  const activeProxyId = proxies.some((p) => p.id === requestedActive) ? requestedActive : null;

  return {
    proxyMode: PROXY_MODES.includes(d.proxyMode) ? d.proxyMode : 'none',
    activeProxyId,
    proxies,
    timeoutMs: toInt(d.timeoutMs, 1, 3600000, DEFAULT_NETWORK_SETTINGS.timeoutMs),
    followRedirects: toBool(d.followRedirects, DEFAULT_NETWORK_SETTINGS.followRedirects),
    maxRedirects: toInt(d.maxRedirects, 0, 50, DEFAULT_NETWORK_SETTINGS.maxRedirects),
    verifyTls: toBool(d.verifyTls, DEFAULT_NETWORK_SETTINGS.verifyTls),
    maxResponseBytes: toInt(
      d.maxResponseBytes,
      1024,
      1073741824,
      DEFAULT_NETWORK_SETTINGS.maxResponseBytes
    ),
    customCaPath: toStr(d.customCaPath).trim(),
    clientCertPath: toStr(d.clientCertPath).trim(),
    clientKeyPath: toStr(d.clientKeyPath).trim(),
    servername: toStr(d.servername).trim(),
    clientCertPassphraseEnc: toStr(d.clientCertPassphraseEnc),
    hasClientCertPassphrase: toBool(d.hasClientCertPassphrase, false),
  };
}

/**
 * Renderer-safe view of the settings: same shape, but every secret is replaced
 * by a boolean presence flag.
 */
export function sanitizeNetworkSettings(raw) {
  const { clientCertPassphraseEnc, hasClientCertPassphrase, proxies, ...rest } =
    normalizeNetworkSettings(raw);
  return {
    ...rest,
    hasClientCertPassphrase: Boolean(clientCertPassphraseEnc) || Boolean(hasClientCertPassphrase),
    proxies: proxies.map((p) => ({
      id: p.id,
      name: p.name,
      protocol: p.protocol,
      host: p.host,
      port: p.port,
      username: p.username,
      bypass: p.bypass,
      hasPassword: Boolean(p.passwordEnc) || Boolean(p.hasPassword),
    })),
  };
}
