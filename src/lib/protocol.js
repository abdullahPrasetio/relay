// Protocol detection shared by the renderer. Pure and DOM-free so it can be
// used from tests and from the send path without touching the request engine.
//
// A URL without a scheme is assumed to be HTTPS, mirroring the HTTP engine's
// `rawUrl` handling (e.g. "api.example.com/users"). Only the schemes Relay
// actually speaks are recognised; anything else returns null.

const SUPPORTED = new Set(['http', 'https', 'ws', 'wss']);

/**
 * Return the lower-case protocol of a raw URL.
 *
 * - `https://…` -> "https"
 * - `wss://…`   -> "wss"
 * - `api.example.com` (no scheme) -> "https"
 * - empty / non-string / unsupported scheme -> null
 */
export function protocolFor(url) {
  if (typeof url !== 'string') return null;
  const raw = url.trim();
  if (!raw) return null;

  const match = /^([a-z][a-z0-9+.-]*):(\/\/)?/i.exec(raw);
  if (!match) return 'https';

  // No `//`: either a host with a port ("localhost:8080") or a non-network
  // scheme like "mailto:". Only the former is a usable HTTP URL.
  if (!match[2]) {
    const rest = raw.slice(match[0].length);
    return /^\d+(?:[/?#]|$)/.test(rest) ? 'https' : null;
  }

  const scheme = match[1].toLowerCase();
  return SUPPORTED.has(scheme) ? scheme : null;
}

/** True for ws:// and wss:// URLs. */
export function isWebSocket(url) {
  const protocol = protocolFor(url);
  return protocol === 'ws' || protocol === 'wss';
}
