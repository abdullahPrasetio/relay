import { WebSocket } from 'ws';

// Long-lived WebSocket sessions owned by the main process. The renderer only
// sees the session id it generated; sockets never live in the renderer, so
// CSP/CORS do not apply and the app can keep a socket open across panels.
//
// Limits:
// - 10 s connect timeout (handshake failure or a server that never answers).
// - Per-session history: 500 messages / 1 MB, oldest dropped first.
// - No automatic reconnect, no heartbeat/ping, no per-message compression
//   configuration. Those are deliberate Phase 5 limits.

const CONNECT_TIMEOUT_MS = 10000;
const MAX_HISTORY_MESSAGES = 500;
const MAX_HISTORY_BYTES = 1024 * 1024;

const sessions = new Map();

const now = () => Date.now();

function isWsUrl(url) {
  return /^wss?:\/\//i.test(String(url || '').trim());
}

function normalizeHeaders(headers) {
  const out = {};
  if (Array.isArray(headers)) {
    for (const header of headers) {
      if (!header || header.enabled === false) continue;
      const key = String(header.key || '').trim();
      if (!key) continue;
      out[key] = String(header.value ?? '');
    }
    return out;
  }
  if (headers && typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) {
      if (!key || value == null) continue;
      out[key] = String(value);
    }
  }
  return out;
}

function normalizeProtocols(protocols) {
  if (typeof protocols === 'string') {
    return [...new Set(protocols.split(',').map((p) => p.trim()).filter(Boolean))];
  }
  if (!Array.isArray(protocols)) return [];
  return [...new Set(protocols.map((p) => String(p ?? '').trim()).filter(Boolean))];
}

function recordHistory(session, event) {
  session.history.push(event);
  session.historyBytes += event.size || 0;

  while (
    session.history.length > MAX_HISTORY_MESSAGES ||
    session.historyBytes > MAX_HISTORY_BYTES
  ) {
    const dropped = session.history.shift();
    session.historyBytes -= dropped?.size || 0;
    session.dropped += 1;
  }
}

function emit(session, event) {
  // Only message frames are part of the replayable history. open/close/error
  // are UI state, not conversation content.
  if (event.type === 'text' || event.type === 'binary') {
    recordHistory(session, event);
  }
  try {
    session.onEvent?.(event);
  } catch {
    /* a renderer callback must never take the session down */
  }
}

/**
 * Open a socket and resolve once the handshake completed.
 *
 * `onEvent` receives:
 *   { type: 'open', at }
 *   { type: 'text', data, size, at }
 *   { type: 'binary', base64, size, at }
 *   { type: 'close', code, reason, at }
 *   { type: 'error', message, at }
 */
export async function openSession({
  id,
  url,
  headers,
  protocols,
  onEvent,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
} = {}) {
  const sessionId = typeof id === 'string' ? id : '';
  if (!sessionId) throw new Error('WebSocket session id is required');

  const target = String(url || '').trim();
  if (!isWsUrl(target)) {
    throw new Error('WebSocket URL must start with ws:// or wss://');
  }

  // Reconnecting with the same renderer id replaces the old socket instead of
  // leaking it.
  if (sessions.has(sessionId)) await closeSession(sessionId, 1000, 'Replaced');

  const session = {
    id: sessionId,
    onEvent,
    ws: null,
    opened: false,
    closed: false,
    history: [],
    historyBytes: 0,
    dropped: 0,
  };
  sessions.set(sessionId, session);

  let ws;
  try {
    ws = new WebSocket(target, normalizeProtocols(protocols), {
      headers: normalizeHeaders(headers),
      handshakeTimeout: connectTimeoutMs,
      followRedirects: false,
      perMessageDeflate: false,
    });
  } catch (err) {
    sessions.delete(sessionId);
    throw new Error(`WebSocket connection failed: ${err?.message || String(err)}`);
  }
  session.ws = ws;

  return new Promise((resolve, reject) => {
    let settled = false;

    const fail = (message) => {
      if (settled) return false;
      settled = true;
      sessions.delete(sessionId);
      reject(new Error(message));
      return true;
    };

    const timer = setTimeout(() => {
      if (settled) return;
      const message = `WebSocket connection timed out after ${connectTimeoutMs}ms`;
      emit(session, { type: 'error', message, at: now() });
      fail(message);
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
    }, connectTimeoutMs);
    timer.unref?.();

    ws.on('open', () => {
      if (session.closed) return;
      session.opened = true;
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
      emit(session, { type: 'open', at: now() });
    });

    ws.on('message', (data, isBinary) => {
      if (session.closed) return;
      if (isBinary) {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
        emit(session, {
          type: 'binary',
          base64: buffer.toString('base64'),
          size: buffer.length,
          at: now(),
        });
      } else {
        const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        emit(session, {
          type: 'text',
          data: text,
          size: Buffer.byteLength(text, 'utf8'),
          at: now(),
        });
      }
    });

    ws.on('error', (err) => {
      const message = err?.message || 'WebSocket error';
      emit(session, { type: 'error', message, at: now() });
      fail(`WebSocket connection failed: ${message}`);
    });

    ws.on('close', (code, reasonBuffer) => {
      clearTimeout(timer);
      const reason = reasonBuffer ? reasonBuffer.toString() : '';
      session.closed = true;
      if (sessions.get(sessionId) === session) sessions.delete(sessionId);
      emit(session, { type: 'close', code, reason, at: now() });

      if (!settled) {
        const detail = reason ? `: ${reason}` : '';
        fail(`WebSocket closed before opening (${code}${detail})`);
      }
    });
  });
}

/**
 * Send one frame. Text and base64 payloads are mutually exclusive; `text`
 * wins when both are supplied. Throws when the session is not open.
 */
export async function sendFrame(id, payload = {}) {
  const session = sessions.get(id);
  const ws = session?.ws;
  if (!session || !session.opened || session.closed || !ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('WebSocket is not open');
  }

  return new Promise((resolve, reject) => {
    const isBinary = payload.base64 !== undefined && payload.text === undefined;
    const data = isBinary
      ? Buffer.from(String(payload.base64 ?? ''), 'base64')
      : String(payload.text ?? '');

    try {
      ws.send(data, { binary: isBinary }, (err) => {
        if (err) reject(new Error(`WebSocket send failed: ${err.message}`));
        else resolve();
      });
    } catch (err) {
      reject(new Error(`WebSocket send failed: ${err?.message || String(err)}`));
    }
  });
}

/**
 * Close a session and forget it. Returns false for an unknown id (closing an
 * already-closed socket is not an error).
 */
export async function closeSession(id, code = 1000, reason = '') {
  const session = sessions.get(id);
  if (!session) return false;

  sessions.delete(id);
  const ws = session.ws;
  if (!ws) return true;

  try {
    if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
    else if (ws.readyState === WebSocket.OPEN) ws.close(code, String(reason || '').slice(0, 123));
    else ws.terminate();
  } catch {
    /* the socket may already be gone */
  }
  return true;
}

/**
 * Snapshot of a session's replayable history. The snapshot is an array (so
 * `.length`/iteration work) carrying the drop counters as extra properties.
 */
export function getHistory(id) {
  const session = sessions.get(id);
  const messages = session ? session.history.slice() : [];
  Object.defineProperties(messages, {
    messages: { value: messages, enumerable: false },
    dropped: { value: session?.dropped || 0, enumerable: false },
    bytes: { value: session?.historyBytes || 0, enumerable: false },
  });
  return messages;
}

/** Terminate every session (app shutdown). Safe to call more than once. */
export function closeAll() {
  for (const [id, session] of sessions) {
    sessions.delete(id);
    try {
      session.ws?.terminate();
    } catch {
      /* ignore shutdown races */
    }
  }
}
