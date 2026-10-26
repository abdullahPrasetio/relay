import fs from 'node:fs';
import { resolveProxy } from './proxy.js';

// Per-request network context.
//
// Everything the request engine needs to obey the user's network policy is
// assembled here: timeout + cancellation (a single AbortController), redirect
// policy, response size cap, proxy selection and TLS material. Keeping it in
// one place means the engine stays a pure transport and callers cannot forget
// to clean up the timeout timer.

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_RESPONSE_BYTES = 52428800;

function pick(value, fallback) {
  return value === null || value === undefined ? fallback : value;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Build Node TLS options from the app-level settings. Files are read eagerly so
 * a bad path fails before the request (and before the timeout timer) starts.
 */
export function buildTlsOptions(network) {
  const tls = { rejectUnauthorized: network.verifyTls !== false };
  const read = (p) => {
    try {
      return fs.readFileSync(p);
    } catch (err) {
      throw new Error(`Cannot read TLS file ${p}: ${err.message}`);
    }
  };
  if (network.customCaPath) tls.ca = read(network.customCaPath);
  if (network.clientCertPath) tls.cert = read(network.clientCertPath);
  if (network.clientKeyPath) tls.key = read(network.clientKeyPath);
  if (network.clientCertPassphrase) tls.passphrase = network.clientCertPassphrase;
  return tls;
}

/**
 * Assemble the options object for `sendRequest`, plus `abort`/`cleanup`.
 * `network` must already have decrypted secrets applied (see getRuntimeNetwork
 * in electron/main.js).
 */
export function createSendContext({ network, request }) {
  const settings = request?.settings || {};

  const timeoutMs = clampInt(
    pick(settings.timeoutMs, network.timeoutMs),
    1,
    3600000,
    DEFAULT_TIMEOUT_MS
  );
  const followRedirects = pick(settings.followRedirects, network.followRedirects) !== false;
  const maxRedirects = clampInt(
    pick(settings.maxRedirects, network.maxRedirects),
    0,
    50,
    DEFAULT_MAX_REDIRECTS
  );
  const verifyTls = pick(settings.verifyTls, network.verifyTls) !== false;
  const maxResponseBytes = clampInt(
    network.maxResponseBytes,
    1024,
    1073741824,
    DEFAULT_MAX_RESPONSE_BYTES
  );

  // The engine prefixes a scheme when the user omits one; mirror that so
  // environment-proxy selection sees the same protocol.
  const rawUrl = String(request?.url || '').trim();
  const targetUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  const proxy = resolveProxy({
    targetUrl,
    network,
    requestSettings: settings,
  });

  const tls = buildTlsOptions({ ...network, verifyTls });

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)),
    timeoutMs
  );

  return {
    options: {
      signal: controller.signal,
      followRedirects,
      maxRedirects,
      verifyTls,
      maxResponseBytes,
      proxy,
      tls,
    },
    abort: (reason) => controller.abort(reason || new Error('Request aborted')),
    cleanup: () => clearTimeout(timer),
  };
}
