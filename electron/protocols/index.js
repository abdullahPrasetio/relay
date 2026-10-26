// Protocol adapter registry. The main process and the request engine keep
// their own transport implementations; this module is the single place that
// maps a URL scheme to a descriptor so callers never branch on raw strings.
//
// Descriptors:
//   http/https:      { id, kind: 'request' }
//   ws/wss:          { id, kind: 'stream', open, send, close, history }
//   mqtt/mqtts:      { id, kind: 'stream', open, send, close, history, ... }
//   socketio:        { id, kind: 'stream', open, send, close, history }
//   grpc:            { id, kind: 'stream', services, invoke, open, cancel }
//
// gRPC URL rule: `grpc://` and `grpcs://` both normalise to protocol "grpc";
// TLS is a per-call flag derived from the scheme by the renderer.
//
// Socket.IO URL rule (unambiguous): only the explicit schemes
// `socketio://`, `socketios://`, `socket.io://` and `io://` select Socket.IO;
// an http(s) URL containing a path/query marker never does. Both this module
// and `src/lib/protocol.js` implement the same rule.
//
// Keep this module free of Electron imports so unit tests can load it in Node.

import {
  openSession as openWsSession,
  sendFrame as sendWsFrame,
  closeSession as closeWsSession,
  getHistory as getWsHistory,
} from './websocket.js';
import {
  openSession as openMqttSession,
  publish as publishMqtt,
  subscribe as subscribeMqtt,
  unsubscribe as unsubscribeMqtt,
  closeSession as closeMqttSession,
  getHistory as getMqttHistory,
} from './mqtt.js';
import {
  openSession as openSocketIoSession,
  emit as emitSocketIo,
  closeSession as closeSocketIoSession,
  getHistory as getSocketIoHistory,
} from './socketio.js';
import {
  loadServices as loadGrpcServices,
  invokeUnary as invokeGrpcUnary,
  startServerStream as startGrpcStream,
  cancelStream as cancelGrpcStream,
  closeAll as closeAllGrpcStreams,
} from './grpc.js';

const SUPPORTED = new Set(['http', 'https', 'ws', 'wss', 'mqtt', 'mqtts']);
const SOCKET_IO_SCHEMES = new Set(['socketio', 'socketios', 'socket.io', 'io']);
// Both `grpc://` and `grpcs://` normalise to one protocol id; TLS is a
// per-call flag (derived from the scheme by the renderer), not a protocol.
const GRPC_SCHEMES = new Set(['grpc', 'grpcs']);

/**
 * Return the protocol for a raw URL. Scheme-less URLs default to https,
 * mirroring the HTTP engine. Unknown/empty input returns null.
 *
 * Socket.IO schemes normalise to `socketio`.
 */
export function protocolFor(url) {
  if (typeof url !== 'string') return null;
  const raw = url.trim();
  if (!raw) return null;

  const match = /^([a-z][a-z0-9+.-]*):(\/\/)?/i.exec(raw);
  if (!match) return 'https';

  if (!match[2]) {
    const rest = raw.slice(match[0].length);
    if (GRPC_SCHEMES.has(match[1].toLowerCase()) && rest) return 'grpc';
    return /^\d+(?:[/?#]|$)/.test(rest) ? 'https' : null;
  }

  const scheme = match[1].toLowerCase();
  if (SOCKET_IO_SCHEMES.has(scheme)) return 'socketio';
  if (GRPC_SCHEMES.has(scheme)) return 'grpc';
  return SUPPORTED.has(scheme) ? scheme : null;
}

const mqttAdapter = {
  id: 'mqtt',
  kind: 'stream',
  open: openMqttSession,
  send: publishMqtt,
  subscribe: subscribeMqtt,
  unsubscribe: unsubscribeMqtt,
  close: closeMqttSession,
  history: getMqttHistory,
};

const socketIoAdapter = {
  id: 'socketio',
  kind: 'stream',
  open: openSocketIoSession,
  send: emitSocketIo,
  close: closeSocketIoSession,
  history: getSocketIoHistory,
};

// gRPC is stream-shaped from the renderer's point of view: unary calls are
// request/response, server streams are long-lived. `open` starts a stream,
// `cancel` stops it, and `invoke`/`services` cover the unary and proto paths.
const grpcAdapter = {
  id: 'grpc',
  kind: 'stream',
  services: loadGrpcServices,
  invoke: invokeGrpcUnary,
  open: startGrpcStream,
  cancel: cancelGrpcStream,
  closeAll: closeAllGrpcStreams,
};

const adapters = {
  http: { id: 'http', kind: 'request' },
  https: { id: 'https', kind: 'request' },
  ws: {
    id: 'ws',
    kind: 'stream',
    open: openWsSession,
    send: sendWsFrame,
    close: closeWsSession,
    history: getWsHistory,
  },
  wss: {
    id: 'wss',
    kind: 'stream',
    open: openWsSession,
    send: sendWsFrame,
    close: closeWsSession,
    history: getWsHistory,
  },
  mqtt: mqttAdapter,
  mqtts: { ...mqttAdapter, id: 'mqtts' },
  grpc: grpcAdapter,
  grpcs: { ...grpcAdapter, id: 'grpcs' },
  socketio: socketIoAdapter,
  // Aliases for callers that look up the raw scheme name.
  'socket.io': socketIoAdapter,
  socketios: socketIoAdapter,
  io: socketIoAdapter,
};

/**
 * Look up the adapter for a protocol. `getAdapter('wss')` and
 * `getAdapter('ws')` both resolve stream adapters; unknown protocols return
 * null rather than throwing.
 */
export function getAdapter(protocol) {
  if (typeof protocol !== 'string') return null;
  return adapters[protocol.trim().toLowerCase()] || null;
}

export default adapters;
