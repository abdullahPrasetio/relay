// Protocol adapter registry. The main process and the request engine keep
// their own transport implementations; this module is the single place that
// maps a URL scheme to a descriptor so callers never branch on raw strings.
//
// Descriptors:
//   http/https: { id, kind: 'request' }
//   ws/wss:     { id, kind: 'stream', open, send, close, history }
//
// Keep this module free of Electron imports so unit tests can load it in Node.

import {
  openSession,
  sendFrame,
  closeSession,
  getHistory,
} from './websocket.js';

const SUPPORTED = new Set(['http', 'https', 'ws', 'wss']);

/**
 * Return the protocol for a raw URL. Scheme-less URLs default to https,
 * mirroring the HTTP engine. Unknown/empty input returns null.
 */
export function protocolFor(url) {
  if (typeof url !== 'string') return null;
  const raw = url.trim();
  if (!raw) return null;

  const match = /^([a-z][a-z0-9+.-]*):(\/\/)?/i.exec(raw);
  if (!match) return 'https';

  if (!match[2]) {
    const rest = raw.slice(match[0].length);
    return /^\d+(?:[/?#]|$)/.test(rest) ? 'https' : null;
  }

  const scheme = match[1].toLowerCase();
  return SUPPORTED.has(scheme) ? scheme : null;
}

const adapters = {
  http: { id: 'http', kind: 'request' },
  https: { id: 'https', kind: 'request' },
  ws: {
    id: 'ws',
    kind: 'stream',
    open: openSession,
    send: sendFrame,
    close: closeSession,
    history: getHistory,
  },
  wss: {
    id: 'wss',
    kind: 'stream',
    open: openSession,
    send: sendFrame,
    close: closeSession,
    history: getHistory,
  },
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
