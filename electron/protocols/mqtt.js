import mqtt from 'mqtt';
import { isUtf8 } from 'node:buffer';

// Long-lived MQTT sessions owned by the main process. The renderer only sees
// the session id it generated (the broker connection never lives in the
// renderer), mirroring the WebSocket manager.
//
// Deliberate limits (Phase 5):
// - 10 s connect timeout, no automatic reconnect (`reconnectPeriod: 0`).
// - Per-session history: 500 messages / 1 MB, oldest dropped first.
// - History is in memory only; it is lost when the app quits.
// - URLs, credentials and payloads are never logged.

const CONNECT_TIMEOUT_MS = 10000;
const MAX_HISTORY_MESSAGES = 500;
const MAX_HISTORY_BYTES = 1024 * 1024;

const ALLOWED_SCHEMES = new Set(['mqtt:', 'mqtts:', 'ws:', 'wss:']);

const now = () => Date.now();

function normalizeUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) throw new Error('MQTT URL is required');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid MQTT URL: ${raw}`);
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new Error('MQTT URL must start with mqtt://, mqtts://, ws:// or wss://');
  }
  return raw;
}

function clampQos(value) {
  const qos = Number(value);
  return qos === 1 || qos === 2 ? qos : 0;
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
  // Only broker messages are replayable; connect/error/close are UI state.
  if (event.type === 'message') recordHistory(session, event);
  try {
    session.onEvent?.(event);
  } catch {
    /* a renderer callback must never take the session down */
  }
}

function messageEvent(topic, payload, packet) {
  const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '');
  const event = {
    type: 'message',
    topic: String(topic ?? ''),
    size: buffer.length,
    qos: clampQos(packet?.qos),
    retain: Boolean(packet?.retain),
    at: now(),
  };
  if (buffer.length > 0 && !isUtf8(buffer)) {
    event.payload = buffer.toString('base64');
  } else {
    event.text = buffer.toString('utf8');
  }
  return event;
}

/**
 * Build an isolated MQTT manager. `connect` is injectable so unit tests can
 * drive a stub client instead of a real broker.
 */
export function createMqttManager({ connect = mqtt.connect } = {}) {
  const sessions = new Map();

  /**
   * Open a broker connection and resolve once CONNACK arrived.
   *
   * `onEvent` receives:
   *   { type: 'connect', clientId, at }
   *   { type: 'message', topic, text?, payload?, size, qos, retain, at }
   *   { type: 'error', message, at }
   *   { type: 'close', at }
   */
  async function openSession({
    id,
    url,
    username,
    password,
    clientId,
    keepalive,
    clean,
    onEvent,
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
  } = {}) {
    const sessionId = typeof id === 'string' ? id : '';
    if (!sessionId) throw new Error('MQTT session id is required');

    const target = normalizeUrl(url);

    // Reconnecting with the same renderer id replaces the old client instead
    // of leaking it.
    if (sessions.has(sessionId)) await closeSession(sessionId);

    const session = {
      id: sessionId,
      onEvent,
      client: null,
      connected: false,
      closed: false,
      history: [],
      historyBytes: 0,
      dropped: 0,
    };

    const options = {
      reconnectPeriod: 0,
      connectTimeout: connectTimeoutMs,
    };
    if (username !== undefined && username !== null) options.username = String(username);
    if (password !== undefined && password !== null) options.password = String(password);
    if (clientId !== undefined && clientId !== null && String(clientId).trim() !== '') {
      options.clientId = String(clientId).trim();
    }
    if (keepalive !== undefined && keepalive !== null) options.keepalive = Number(keepalive);
    if (clean !== undefined && clean !== null) options.clean = Boolean(clean);

    let client;
    try {
      client = connect(target, options);
    } catch (err) {
      throw new Error(`MQTT connection failed: ${err?.message || String(err)}`);
    }
    session.client = client;
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

      const onConnect = () => {
        if (session.closed || announced) return;
        announced = true;
        session.connected = true;
        if (!settled) {
          settled = true;
          cleanupTimer();
          resolve();
        }
        emit(session, {
          type: 'connect',
          clientId: client.options?.clientId || options.clientId || null,
          at: now(),
        });
      };

      const timer = setTimeout(() => {
        const message = `MQTT connection timed out after ${connectTimeoutMs}ms`;
        if (fail(message)) {
          emit(session, { type: 'error', message, at: now() });
          try {
            client.end(true);
          } catch {
            /* already gone */
          }
        }
      }, connectTimeoutMs);
      timer.unref?.();

      client.on('connect', onConnect);

      client.on('message', (topic, payload, packet) => {
        if (session.closed) return;
        emit(session, messageEvent(topic, payload, packet));
      });

      client.on('error', (err) => {
        const message = err?.message || 'MQTT error';
        emit(session, { type: 'error', message, at: now() });
        if (fail(`MQTT connection failed: ${message}`)) {
          try {
            client.end(true);
          } catch {
            /* already gone */
          }
        }
      });

      client.on('close', () => {
        cleanupTimer();
        const wasOpen = session.connected;
        session.connected = false;
        session.closed = true;
        discard();
        emit(session, { type: 'close', at: now() });
        if (!wasOpen) fail('MQTT connection closed before opening');
      });

      // A client (or test stub) that connected synchronously already fired
      // 'connect' before the listener existed; honour its state.
      if (client.connected) onConnect();
    });
  }

  /** Publish a text (`payload`) or base64 (`base64`) message. */
  async function publish(id, payload = {}) {
    const session = sessions.get(id);
    if (!session || session.closed) return false;

    const topic = String(payload.topic || '').trim();
    if (!topic) throw new Error('MQTT topic is required');

    const data =
      payload.base64 !== undefined
        ? Buffer.from(String(payload.base64), 'base64')
        : Buffer.from(String(payload.payload ?? ''), 'utf8');
    const options = { qos: clampQos(payload.qos), retain: Boolean(payload.retain) };

    await new Promise((resolve, reject) => {
      try {
        session.client.publish(topic, data, options, (err) => {
          if (err) reject(new Error(`MQTT publish failed: ${err.message}`));
          else resolve();
        });
      } catch (err) {
        reject(new Error(`MQTT publish failed: ${err?.message || String(err)}`));
      }
    });
    return true;
  }

  /** Subscribe one topic filter. Unknown sessions are a no-op. */
  async function subscribe(id, payload = {}) {
    const session = sessions.get(id);
    if (!session || session.closed) return false;

    const topic = String(payload.topic || '').trim();
    if (!topic) throw new Error('MQTT topic is required');
    const options = { qos: clampQos(payload.qos) };

    await new Promise((resolve, reject) => {
      try {
        session.client.subscribe(topic, options, (err) => {
          if (err) reject(new Error(`MQTT subscribe failed: ${err.message}`));
          else resolve();
        });
      } catch (err) {
        reject(new Error(`MQTT subscribe failed: ${err?.message || String(err)}`));
      }
    });
    return true;
  }

  /** Remove one subscription. Accepts a string topic or `{ topic }`. */
  async function unsubscribe(id, payload = {}) {
    const session = sessions.get(id);
    if (!session || session.closed) return false;

    const topic = String(typeof payload === 'string' ? payload : payload.topic || '').trim();
    if (!topic) throw new Error('MQTT topic is required');

    await new Promise((resolve, reject) => {
      try {
        session.client.unsubscribe(topic, (err) => {
          if (err) reject(new Error(`MQTT unsubscribe failed: ${err.message}`));
          else resolve();
        });
      } catch (err) {
        reject(new Error(`MQTT unsubscribe failed: ${err?.message || String(err)}`));
      }
    });
    return true;
  }

  /** Close and forget a session. Unknown ids return false (not an error). */
  async function closeSession(id) {
    const session = sessions.get(id);
    if (!session) return false;

    sessions.delete(id);
    session.closed = true;
    session.connected = false;
    try {
      session.client?.end(true);
    } catch {
      /* the client may already be gone */
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

  /** Close every broker connection (app shutdown). Safe to call twice. */
  function closeAll() {
    for (const [id, session] of sessions) {
      sessions.delete(id);
      session.closed = true;
      session.connected = false;
      try {
        session.client?.end(true);
      } catch {
        /* ignore shutdown races */
      }
    }
  }

  return {
    openSession,
    publish,
    subscribe,
    unsubscribe,
    closeSession,
    getHistory,
    closeAll,
  };
}

// Process-wide manager used by the main process.
const manager = createMqttManager();

export const { openSession, publish, subscribe, unsubscribe, closeSession, getHistory, closeAll } =
  manager;

export default manager;
