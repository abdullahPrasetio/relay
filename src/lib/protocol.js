// Protocol detection shared by the renderer. Pure and DOM-free so it can be
// used from tests and from the send path without touching the request engine.
//
// A URL without a scheme is assumed to be HTTPS, mirroring the HTTP engine's
// `rawUrl` handling (e.g. "api.example.com/users"). Only the schemes Relay
// actually speaks are recognised; anything else returns null.
//
// Socket.IO URL rule (unambiguous, mirrored by electron/protocols/index.js):
// only explicit schemes select Socket.IO - `socketio://`, `socketios://`,
// `socket.io://` and `io://` all normalise to "socketio". An http(s) URL with
// a `/socket.io` path or an `io` query marker stays an HTTP request.
//
// gRPC rule: `grpc://` and `grpcs://` both normalise to "grpc". The TLS flag
// is not part of the protocol; `isGrpcTls` reads it from the scheme.

const SUPPORTED = new Set(['http', 'https', 'ws', 'wss', 'mqtt', 'mqtts']);
const SOCKET_IO_SCHEMES = new Set(['socketio', 'socketios', 'socket.io', 'io']);
const GRPC_SCHEMES = new Set(['grpc', 'grpcs']);

/**
 * Return the lower-case protocol of a raw URL.
 *
 * - `https://…` -> "https"
 * - `wss://…`   -> "wss"
 * - `mqtt://…`  -> "mqtt"
 * - `socketio://…`, `io://…`, `socket.io://…` -> "socketio"
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
    // `grpc:127.0.0.1:50051` (bare scheme, no slashes) is still gRPC.
    if (GRPC_SCHEMES.has(match[1].toLowerCase()) && rest) return 'grpc';
    return /^\d+(?:[/?#]|$)/.test(rest) ? 'https' : null;
  }

  const scheme = match[1].toLowerCase();
  if (SOCKET_IO_SCHEMES.has(scheme)) return 'socketio';
  if (GRPC_SCHEMES.has(scheme)) return 'grpc';
  return SUPPORTED.has(scheme) ? scheme : null;
}

/** True for ws:// and wss:// URLs. */
export function isWebSocket(url) {
  const protocol = protocolFor(url);
  return protocol === 'ws' || protocol === 'wss';
}

/** True for mqtt:// and mqtts:// URLs (including MQTT-over-WebSocket). */
export function isMqtt(url) {
  const protocol = protocolFor(url);
  return protocol === 'mqtt' || protocol === 'mqtts';
}

/** True for the explicit Socket.IO schemes (never inferred from http/https). */
export function isSocketIo(url) {
  return protocolFor(url) === 'socketio';
}

/** True for grpc:// and grpcs:// URLs (and the bare `grpc:host:port` form). */
export function isGrpc(url) {
  return protocolFor(url) === 'grpc';
}

/** `grpcs://` targets use TLS; plain `grpc://` and bare targets do not. */
export function isGrpcTls(url) {
  return /^grpcs:/i.test(String(url || '').trim());
}
