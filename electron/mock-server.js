import http from 'node:http';

// Local mock server: turns saved collection requests + their newest example
// into real HTTP routes. Pure Node (no Electron) so it is unit-testable and
// could later run in a worker.
//
// Deliberate limits (Fase 6 scope):
//   - examples only: no proxying to an upstream, no script execution, no
//     auth handling, no dynamic path-variable values beyond "any segment".
//   - bodies are treated as UTF-8 text; binary examples are out of scope.
//   - responses are buffered and capped at 5 MB.

const MAX_LOG_ENTRIES = 200;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_DELAY_MS = 10000;

function clampDelay(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_DELAY_MS, Math.trunc(n));
}

function clampStatus(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 100 || n > 599) return 200;
  return n;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Path only: strip query/fragment and any scheme+authority. Requests may also
// be stored as "example.com/path" or "{{baseUrl}}/path"; both are tolerated.
function pathnameOf(rawUrl) {
  let path = String(rawUrl || '').trim();
  if (!path) return '/';
  path = path.split('#')[0].split('?')[0];

  const absolute = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*(.*)$/.exec(path);
  if (absolute) {
    path = absolute[1] || '/';
  } else if (path.startsWith('//')) {
    const idx = path.indexOf('/', 2);
    path = idx === -1 ? '/' : path.slice(idx);
  } else if (!path.startsWith('/')) {
    const first = path.split('/')[0];
    const looksLikeHost = /\./.test(first.split(':')[0]);
    const isVariable = /^\{\{.*\}\}$/.test(first);
    if (looksLikeHost || isVariable) {
      const idx = path.indexOf('/');
      path = idx === -1 ? '/' : path.slice(idx);
    } else {
      path = '/' + path;
    }
  }
  return normalizePath(path);
}

export function normalizePath(raw) {
  let path = String(raw || '').split('#')[0].split('?')[0];
  if (!path) return '/';
  if (!path.startsWith('/')) path = '/' + path;
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return path || '/';
}

// `:name` matches exactly one non-empty segment. Trailing slashes are ignored.
function compileRoute(path) {
  if (path === '/') return /^\/$/;
  const segments = path.slice(1).split('/');
  const pattern = segments
    .map((segment) => (/^:[^/]+$/.test(segment) ? '[^/]+' : escapeRegex(segment)))
    .join('/');
  return new RegExp(`^/${pattern}/?$`);
}

function collectRequests(collections, out = []) {
  const walk = (items) => {
    for (const node of items || []) {
      if (!node) continue;
      if (node.type === 'folder' || Array.isArray(node.items)) {
        walk(node.items);
        continue;
      }
      if (node.type === 'request' || node.method || node.url) out.push(node);
    }
  };
  for (const collection of collections || []) {
    if (!collection) continue;
    if (Array.isArray(collection.items)) walk(collection.items);
  }
  return out;
}

// Examples persist response headers as [{key,value,enabled}] in this app, but
// imported/hand-written data may use a plain object. Accept both.
function headerPairs(raw) {
  const pairs = [];
  if (Array.isArray(raw)) {
    for (const header of raw) {
      if (!header || header.enabled === false) continue;
      const key = header.key ?? header.name;
      if (!key) continue;
      pairs.push([String(key), String(header.value ?? '')]);
    }
  } else if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      if (Array.isArray(value)) {
        for (const item of value) pairs.push([key, String(item)]);
      } else {
        pairs.push([key, String(value ?? '')]);
      }
    }
  }
  return pairs;
}

function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function applyCors(headers) {
  // The mock is a local dev tool; it is called from the renderer (and from
  // arbitrary local clients), so every response is permissive.
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase().startsWith('access-control-allow-')) delete headers[key];
  }
  headers['Access-Control-Allow-Origin'] = '*';
  headers['Access-Control-Allow-Headers'] = '*';
  headers['Access-Control-Allow-Methods'] = '*';
}

function jsonBody(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

/**
 * Start a mock server for the given collections.
 *
 * @returns {Promise<{ok:boolean, port:number|null, url:string, routes:Array,
 *   stop:() => Promise<void>, getLogs:() => Array, error?:string}>}
 */
export function startMockServer({
  collections = [],
  port = 0,
  delayMs = 0,
  host = '127.0.0.1',
  onLog,
} = {}) {
  const delay = clampDelay(delayMs);
  const bindHost = String(host || '127.0.0.1');

  const routes = collectRequests(collections).map((request) => {
    const method = String(request.method || 'GET').toUpperCase();
    const path = pathnameOf(request.url);
    return { method, path, request, matcher: compileRoute(path) };
  });
  const routeList = routes.map((route) => ({ method: route.method, path: route.path }));

  const logs = [];
  let logSink = typeof onLog === 'function' ? onLog : null;

  function record(entry) {
    logs.push(entry);
    while (logs.length > MAX_LOG_ENTRIES) logs.shift();
    if (logSink) {
      try {
        logSink(entry);
      } catch {
        /* a broken logger must not break the mock */
      }
    }
  }

  const sockets = new Set();
  const timers = new Set();
  let closing = null;

  const server = http.createServer((req, res) => {
    const startedAt = Date.now();
    const startedHr = process.hrtime.bigint();

    // Consume and discard the request body. Nothing is retained, so the 1 MB
    // read cap is satisfied by construction (bodies are never used).
    req.on('data', () => {});

    const method = String(req.method || 'GET').toUpperCase();
    const path = normalizePath(String(req.url || '/').split('?')[0]);

    const respond = () => {
      if (res.destroyed || res.writableEnded || server.listening === false) return;

      const finish = (status, headers, body) => {
        const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '', 'utf8');
        const capped = buffer.length > MAX_RESPONSE_BYTES
          ? buffer.subarray(0, MAX_RESPONSE_BYTES)
          : buffer;
        const outHeaders = { ...headers };
        if (capped.length > 0 && !hasHeader(outHeaders, 'content-type')) {
          outHeaders['Content-Type'] = 'text/plain; charset=utf-8';
        }
        outHeaders['Content-Length'] = String(capped.length);
        try {
          res.writeHead(status, outHeaders);
          res.end(status === 204 ? undefined : capped);
        } catch {
          /* client went away mid-response */
        }
        record({
          at: startedAt,
          method,
          path,
          status,
          ms: Math.round(Number(process.hrtime.bigint() - startedHr) / 1e6),
        });
      };

      // CORS preflight is answered before route matching so any path works.
      if (method === 'OPTIONS') {
        const headers = {};
        applyCors(headers);
        finish(204, headers, '');
        return;
      }

      const route = routes.find((r) => r.method === method && r.matcher.test(path));
      if (!route) {
        const headers = {};
        applyCors(headers);
        headers['Content-Type'] = 'application/json; charset=utf-8';
        finish(404, headers, jsonBody({
          error: 'No mock route matched',
          method,
          path,
          routes: routeList,
        }));
        return;
      }

      const examples = Array.isArray(route.request.examples) ? route.request.examples : [];
      const example = examples.length ? examples[examples.length - 1] : null;
      if (!example) {
        const headers = {};
        applyCors(headers);
        headers['Content-Type'] = 'application/json; charset=utf-8';
        finish(501, headers, jsonBody({
          error: 'No saved example for this route',
          method,
          path,
        }));
        return;
      }

      const saved = example.response || {};
      const status = clampStatus(saved.status);
      const headers = {};
      for (const [key, value] of headerPairs(saved.headers)) {
        if (key.toLowerCase() === 'content-length') continue;
        headers[key] = value;
      }
      applyCors(headers);
      if (saved.contentType && !hasHeader(headers, 'content-type')) {
        headers['Content-Type'] = String(saved.contentType);
      }

      let text = saved.body;
      if (text == null) text = '';
      else if (typeof text !== 'string') {
        text = typeof text === 'object' ? JSON.stringify(text) : String(text);
      }
      finish(status, headers, Buffer.from(text, 'utf8'));
    };

    if (delay > 0) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        respond();
      }, delay);
      if (typeof timer.unref === 'function') timer.unref();
      timers.add(timer);
    } else {
      respond();
    }
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const requestedPort = Number(port);
  const listenPort = Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65535
    ? requestedPort
    : 0;

  function stop() {
    if (closing) return closing;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    closing = new Promise((resolve) => {
      if (!server.listening) {
        try {
          server.close();
        } catch {
          /* already closed */
        }
        resolve();
        return;
      }
      for (const socket of sockets) {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      }
      server.close(() => resolve());
      // Belt and braces: never leave the caller hanging if close stalls.
      const guard = setTimeout(resolve, 500);
      if (typeof guard.unref === 'function') guard.unref();
    });
    return closing;
  }

  return new Promise((resolve) => {
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      server.removeListener('listening', onListening);
      // Keep close() from emitting an unhandled 'error' on a never-open server.
      server.on('error', () => {});
      try {
        server.close();
      } catch {
        /* never listened */
      }
      resolve({
        ok: false,
        port: null,
        url: '',
        routes: routeList,
        error: error?.message || String(error),
        stop,
        getLogs: () => logs.map((entry) => ({ ...entry })),
      });
    };

    const onListening = () => {
      if (settled) return;
      settled = true;
      server.removeListener('error', fail);
      // The mock must never crash the host app on a stray server error.
      server.on('error', () => {});
      const address = server.address();
      const actualPort = address && typeof address === 'object' ? address.port : null;
      resolve({
        ok: true,
        port: actualPort,
        url: `http://${bindHost}:${actualPort}`,
        routes: routeList,
        stop,
        getLogs: () => logs.map((entry) => ({ ...entry })),
      });
    };

    server.once('error', fail);
    server.once('listening', onListening);

    try {
      server.listen({ port: listenPort, host: bindHost });
    } catch (error) {
      fail(error);
    }
  });
}
