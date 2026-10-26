import { io } from 'socket.io-client';

// Long-lived Socket.IO sessions owned by the main process. The renderer only
// sees the session id it generated; the socket never lives in the renderer.
//
// URL rule (deliberately unambiguous): Socket.IO is selected only by an
// explicit scheme, never inferred from an http(s) path or query marker.
//   socketio://host  / io://host  / socket.io://host  -> http://host
//   socketios://host                                   -> https://host
// Plain http(s)/ws(s) URLs are still accepted here (the adapter can be used
// directly), but the renderer routes those to the HTTP or WebSocket panels.
//
// Deliberate limits (Phase 5):
// - 10 s connect timeout, no automatic reconnect (`reconnection: false`).
// - Per-session history: 500 messages / 1 MB, oldest dropped first.
// - History is in memory only; it is lost when the app quits.
// - Auth payloads and headers are never logged.

const CONNECT_TIMEOUT_MS = 10000;
const MAX_HISTORY_MESSAGES = 500;
const MAX_HISTORY_BYTES = 1024 * 1024;

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);

const now = () => Date.now();

function normalizeUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) throw new Error('Socket.IO URL is required');

  const custom = /^(socketios|socketio|socket\.io|io):\/\/(.*)$/i.exec(raw);
  let target = raw;
  if (custom) {
    const scheme = custom[1].toLowerCase();
    const secure = scheme === 'socketios';
    target = `${secure ? 'https' : 'http'}://${custom[2]}`;
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    throw new Error(`Invalid Socket.IO URL: ${raw}`);
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new Error(
      'Socket.IO URL must start with socketio://, socketios://, http://, https://, ws:// or wss://'
    );
  }
  return target;
}

// Renderer-safe copy of event arguments: plain JSON survives IPC, Buffers are
// tagged, anything exotic degrades to a string instead of throwing.
function serializeArg(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return value;
  if (type === 'bigint') return value.toString();
  if (type === 'function' || type === 'symbol') return String(value);
  if (Buffer.isBuffer(value)) return { type: 'Buffer', base64: value.toString('base64') };
  if (Array.isArray(value)) return value.map((item) => serializeArg(item, depth + 1));
  if (type === 'object') {
    if (depth >= 8) return '[Object]';
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = serializeArg(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

function eventSize(event, args) {
  try {
    return Buffer.byteLength(JSON.stringify({ event, args }), 'utf8');
  } catch {
    return 0;
  }
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

function dispatch(session, event) {
  // Only server-pushed messages are replayable; lifecycle events are UI state.
  if (event.type === 'message') recordHistory(session, event);
  try {
    session.onEvent?.(event);
  } catch {
    /* a renderer callback must never take the session down */
  }
}

/**
 * Build an isolated Socket.IO manager. `connect` is injectable so unit tests
 * can drive a stub socket instead of a real server.
 */
export function createSocketIoManager({ connect = io } = {}) {
  const sessions = new Map();

  /**
   * Open a socket and resolve once connected.
   *
   * `onEvent` receives:
   *   { type: 'connect', socketId, transport, at }
   *   { type: 'message', event, args, at }
   *   { type: 'disconnect', reason, at }
   *   { type: 'error', message, at }
   */
  async function openSession({
    id,
    url,
    auth,
    headers,
    onEvent,
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
  } = {}) {
    const sessionId = typeof id === 'string' ? id : '';
    if (!sessionId) throw new Error('Socket.IO session id is required');

    const target = normalizeUrl(url);

    // Reconnecting with the same renderer id replaces the old socket instead
    // of leaking it.
    if (sessions.has(sessionId)) await closeSession(sessionId);

    const session = {
      id: sessionId,
      onEvent,
      socket: null,
      connected: false,
      closed: false,
      history: [],
      historyBytes: 0,
      dropped: 0,
    };

    const options = {
      auth,
      extraHeaders: headers,
      reconnection: false,
      forceNew: true,
      timeout: connectTimeoutMs,
      autoConnect: true,
    };

    let socket;
    try {
      socket = connect(target, options);
    } catch (err) {
      throw new Error(`Socket.IO connection failed: ${err?.message || String(err)}`);
    }
    session.socket = socket;
    sessions.set(sessionId, session);

    return new Promise((resolve, reject) => {
      let settled = false;
      let announced = false;

      const cleanupTimer = () => clearTimeout(timer);
      const discard = () => {
        if (sessions.get(sessionId) === session) sessions.delete(sessionId);
      };
      const fail = (message) => {
        if (settled) return false;
        settled = true;
        cleanupTimer();
        discard();
        session.closed = true;
        reject(new Error(message));
        return true;
      };
      const stop = () => {
        try {
          socket.disconnect();
        } catch {
          /* already gone */
        }
      };

      const onConnect = () => {
        if (session.closed || announced) return;
        announced = true;
        session.connected = true;
        if (!settled) {
          settled = true;
          cleanupTimer();
          resolve();
        }
        dispatch(session, {
          type: 'connect',
          socketId: socket.id ?? null,
          transport: socket.io?.engine?.transport?.name || null,
          at: now(),
        });
      };

      const timer = setTimeout(() => {
        const message = `Socket.IO connection timed out after ${connectTimeoutMs}ms`;
        if (fail(message)) {
          dispatch(session, { type: 'error', message, at: now() });
          stop();
        }
      }, connectTimeoutMs);
      timer.unref?.();

      socket.onAny?.((event, ...args) => {
        if (session.closed) return;
        const safeArgs = args.map((arg) => serializeArg(arg));
        const name = String(event);
        dispatch(session, {
          type: 'message',
          event: name,
          args: safeArgs,
          size: eventSize(name, safeArgs),
          at: now(),
        });
      });

      socket.on('connect', onConnect);

      socket.on('connect_error', (err) => {
        const message = err?.message || 'Socket.IO connection error';
        dispatch(session, { type: 'error', message, at: now() });
        if (fail(`Socket.IO connection failed: ${message}`)) stop();
      });

      socket.on('disconnect', (reason) => {
        cleanupTimer();
        session.connected = false;
        session.closed = true;
        discard();
        dispatch(session, { type: 'disconnect', reason: reason || '', at: now() });
        // No-op when the handshake already settled; rejects a connect that
        // was closed (by the user or the server) before it opened.
        fail('Socket.IO disconnected before connecting');
      });

      // v4 sockets do not normally emit this, but a stub or a future client
      // might; surfacing it is harmless.
      socket.on?.('error', (err) => {
        dispatch(session, {
          type: 'error',
          message: err?.message || 'Socket.IO error',
          at: now(),
        });
      });

      // A socket (or test stub) that connected synchronously already fired
      // 'connect' before the listener existed; honour its state.
      if (socket.connected) onConnect();
    });
  }

  /** Emit one event. `args` is an array; a single value is wrapped. */
  async function emitEvent(id, event, args) {
    const session = sessions.get(id);
    if (!session || session.closed) return false;

    const name = String(event || '').trim();
    if (!name) throw new Error('Socket.IO event name is required');
    if (!session.connected) throw new Error('Socket.IO is not connected');

    const list = Array.isArray(args) ? args : args === undefined ? [] : [args];
    session.socket.emit(name, ...list);
    return true;
  }

  /** Disconnect and forget a session. Unknown ids return false. */
  async function closeSession(id) {
    const session = sessions.get(id);
    if (!session) return false;

    sessions.delete(id);
    session.closed = true;
    session.connected = false;
    try {
      session.socket?.disconnect();
    } catch {
      /* the socket may already be gone */
    }
    return true;
  }

  /** Snapshot of a session's replayable messages, with `dropped` attached. */
  function getHistory(id) {
    const session = sessions.get(id);
    const messages = session ? session.history.slice() : [];
    Object.defineProperties(messages, {
      messages: { value: messages, enumerable: false },
      dropped: { value: session?.dropped || 0, enumerable: false },
      bytes: { value: session?.historyBytes || 0, enumerable: false },
    });
    return messages;
  }

  /** Disconnect every socket (app shutdown). Safe to call twice. */
  function closeAll() {
    for (const [id, session] of sessions) {
      sessions.delete(id);
      session.closed = true;
      session.connected = false;
      try {
        session.socket?.disconnect();
      } catch {
        /* ignore shutdown races */
      }
    }
  }

  return { openSession, emit: emitEvent, closeSession, getHistory, closeAll };
}

// Process-wide manager used by the main process.
const manager = createSocketIoManager();

export const { openSession, emit, closeSession, getHistory, closeAll } = manager;

export default manager;
