// Server-Sent Events consumer for relay-api workspace changes.
//
// Runs in the main process: the access token is fetched from the injected
// provider on every (re)connect and never logged or returned. The stream
// emits one `{ seq }` per `data: {"seq":N}` event; heartbeat comment lines
// (`: ping`) are consumed and ignored.
//
// Reconnection is ours rather than EventSource's: after a network error, a
// non-2xx response, or EOF we retry with exponential backoff from 1s up to
// 30s. `stop()` aborts the in-flight request and is idempotent.

const DEFAULT_BASE_URL = 'http://127.0.0.1:8080';
const API_PREFIX = '/api/v1';
const DEFAULT_INITIAL_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30000;
const DEFAULT_FACTOR = 2;

/** Accept either a bare origin or one that already ends in /api/vN. */
export function normalizeBaseUrl(raw) {
  const trimmed = String(raw || DEFAULT_BASE_URL).replace(/\/+$/, '') || DEFAULT_BASE_URL;
  return /\/api\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}${API_PREFIX}`;
}

function requireWorkspaceId(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('workspaceId is required');
  }
  return encodeURIComponent(value);
}

function parseData(data) {
  try {
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function createChangeStream({
  baseUrl = process.env.RELAY_API_URL || DEFAULT_BASE_URL,
  tokenProvider,
  fetchImpl = globalThis.fetch,
  reconnect = {},
} = {}) {
  if (typeof tokenProvider !== 'function') {
    throw new TypeError('createChangeStream requires a tokenProvider function');
  }
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createChangeStream requires a fetch implementation');
  }

  let root = normalizeBaseUrl(baseUrl);
  const initialDelayMs = positive(reconnect.initialDelayMs, DEFAULT_INITIAL_DELAY_MS);
  const maxDelayMs = positive(reconnect.maxDelayMs, DEFAULT_MAX_DELAY_MS);
  const factor = positive(reconnect.factor, DEFAULT_FACTOR);
  // Inject points for deterministic tests: `jitter(delayMs, attempt)` maps the
  // computed delay to the actual one.
  const jitter = typeof reconnect.jitter === 'function' ? reconnect.jitter : (delay) => delay;

  // One active subscription at a time. `start` replaces a previous one.
  let session = null;

  function notify(current, status) {
    if (typeof current.onStatus !== 'function') return;
    try {
      current.onStatus(status);
    } catch {
      /* a broken observer must not break the stream */
    }
  }

  function emit(current, event) {
    if (typeof current.onEvent !== 'function') return;
    try {
      current.onEvent(event);
    } catch {
      /* same for event consumers */
    }
  }

  function nextDelay(attempt) {
    const base = Math.min(maxDelayMs, initialDelayMs * factor ** attempt);
    let value;
    try {
      value = Number(jitter(base, attempt));
    } catch {
      return base;
    }
    if (!Number.isFinite(value)) return base;
    return Math.max(0, Math.min(maxDelayMs, value));
  }

  function scheduleReconnect(current, reason, extra = {}) {
    if (current.stopped) return;
    const attempt = current.attempt;
    current.attempt = attempt + 1;
    const delayMs = nextDelay(attempt);
    notify(current, { state: 'reconnecting', attempt, delayMs, reason, ...extra });
    current.timer = setTimeout(() => {
      current.timer = null;
      void connect(current);
    }, delayMs);
    if (typeof current.timer.unref === 'function') current.timer.unref();
  }

  async function readStream(response, current) {
    const body = response.body;
    if (!body) return;

    const decoder = new TextDecoder();
    let buffer = '';
    let event = { id: null, data: [] };

    function flush() {
      if (!event.data.length) {
        event = { id: null, data: [] };
        return;
      }
      const data = event.data.join('\n');
      const parsed = parseData(data);
      const candidate = Number.isFinite(parsed?.seq) ? parsed.seq : Number(event.id);
      event = { id: null, data: [] };
      if (!Number.isFinite(candidate)) return;
      // Data flowed, so the next failure should retry from the initial delay
      // rather than continuing a stale backoff.
      current.attempt = 0;
      current.lastSeq = candidate;
      emit(current, { seq: candidate, data });
    }

    function line(raw) {
      const value = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (value === '') {
        flush();
        return;
      }
      // Comment line: SSE heartbeats keep the connection warm and carry no data.
      if (value.startsWith(':')) return;
      const colon = value.indexOf(':');
      const field = colon === -1 ? value : value.slice(0, colon);
      let content = colon === -1 ? '' : value.slice(colon + 1);
      if (content.startsWith(' ')) content = content.slice(1);
      if (field === 'data') event.data.push(content);
      else if (field === 'id' && content) event.id = content;
      // `event:` and `retry:` are not part of the change-stream contract.
    }

    function consume(chunk) {
      buffer += chunk;
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) line(part);
    }

    if (typeof body.getReader === 'function') {
      const reader = body.getReader();
      try {
        while (!current.stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          consume(decoder.decode(value, { stream: true }));
        }
        consume(decoder.decode());
        // The server may close without the blank line that ends an event.
        buffer += '\n\n';
        consume('');
        flush();
      } finally {
        try {
          await reader.cancel();
        } catch {
          /* already errored/aborted */
        }
        try {
          reader.releaseLock?.();
        } catch {
          /* ignore */
        }
      }
      return;
    }

    // Fallback for fetch implementations exposing an async-iterable body.
    for await (const chunk of body) {
      if (current.stopped) break;
      consume(decoder.decode(chunk, { stream: true }));
    }
    consume(decoder.decode());
    flush();
  }

  async function connect(current) {
    if (current.stopped) return;

    let token;
    try {
      token = await tokenProvider(current.workspaceId);
    } catch {
      scheduleReconnect(current, 'token', { message: 'Could not obtain an access token' });
      return;
    }
    if (current.stopped) return;
    if (!token || typeof token !== 'string') {
      scheduleReconnect(current, 'token', { message: 'No access token available' });
      return;
    }

    const controller = new AbortController();
    current.controller = controller;
    notify(current, { state: 'connecting', attempt: current.attempt });

    const headers = { accept: 'text/event-stream', 'cache-control': 'no-cache' };
    headers.authorization = `Bearer ${token}`;
    if (Number.isFinite(current.lastSeq)) headers['last-event-id'] = String(current.lastSeq);

    let response;
    try {
      response = await fetchImpl(
        `${root}/workspaces/${current.pathId}/stream`,
        { method: 'GET', headers, signal: controller.signal, cache: 'no-store' }
      );
    } catch {
      if (current.stopped) return;
      scheduleReconnect(current, 'offline');
      return;
    }

    if (!response || !response.ok) {
      const httpStatus = Number(response?.status) || 0;
      try {
        await response?.body?.cancel?.();
      } catch {
        /* body may not be cancelable */
      }
      if (current.stopped) return;
      scheduleReconnect(current, 'http', { httpStatus });
      return;
    }

    notify(current, { state: 'open', attempt: current.attempt });
    try {
      await readStream(response, current);
    } catch {
      if (current.stopped) return;
      scheduleReconnect(current, 'offline');
      return;
    }
    if (current.stopped) return;
    scheduleReconnect(current, 'eof');
  }

  function start(workspaceId, onEvent, onStatus) {
    const pathId = requireWorkspaceId(workspaceId);
    stop();

    const current = {
      workspaceId,
      pathId,
      onEvent,
      onStatus,
      attempt: 0,
      lastSeq: undefined,
      controller: null,
      timer: null,
      stopped: false,
    };
    session = current;
    void connect(current);
    return { workspaceId };
  }

  function stop() {
    const current = session;
    if (!current) return;
    session = null;
    current.stopped = true;
    if (current.timer) {
      clearTimeout(current.timer);
      current.timer = null;
    }
    try {
      current.controller?.abort();
    } catch {
      /* already aborted */
    }
    current.controller = null;
    notify(current, { state: 'closed' });
  }

  function setBaseUrl(next) {
    root = normalizeBaseUrl(next);
    return root;
  }

  return { start, stop, setBaseUrl };
}

function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
