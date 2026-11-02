import http from 'node:http';
import {
  configNeedsBody,
  normalizeMockConfig,
  pathnameOf,
  renderMockTemplate,
  selectScenario,
  sortRoutes,
  compileRoute,
  normalizePath,
  matchRoutes,
} from '../shared/mockScenarios.js';

// Local mock server: turns saved collection requests into real HTTP routes.
// Responses come from an active mock scenario, falling back to the newest
// saved example (the pre-scenario behaviour). Pure Node so it stays unit
// testable and can move to a worker later.
//
// Deliberate limits: loopback only, no auth, no proxy/upstream, no scripts,
// no variable/secret resolution, text bodies, 5 MB response cap.

const MAX_LOG_ENTRIES = 200;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_DELAY_MS = 10000;

export { normalizePath };

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

function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function applyCors(headers) {
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

// Examples persist response headers as [{key,value,enabled}], but imported or
// handwritten data may use a plain object. Accept both.
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

function parseJsonBody(text, contentType) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const jsonish =
    /json/i.test(String(contentType || '')) || raw.startsWith('{') || raw.startsWith('[');
  if (!jsonish) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let text = '';
    let size = 0;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(text);
    };
    req.on('data', (chunk) => {
      if (size >= MAX_REQUEST_BODY_BYTES) return;
      const room = MAX_REQUEST_BODY_BYTES - size;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      text += part.toString('utf8');
      size += part.length;
    });
    req.on('end', done);
    req.on('error', done);
    req.on('aborted', done);
  });
}

function buildRoutes(collections) {
  return collectRequests(collections)
    .map((request, order) => {
      const method = String(request.method || 'GET').toUpperCase();
      const path = pathnameOf(request.url);
      const compiled = compileRoute(path);
      const mock = normalizeMockConfig(request.mock);
      if (!mock.enabled) return null;
      return {
        requestId: String(request.id || `mock_route_${order}`),
        requestName: request.name || 'Untitled Request',
        method,
        path,
        ...compiled,
        mock,
        order,
        request,
      };
    })
    .filter(Boolean);
}

function routeList(routes) {
  return routes.map((route) => ({ method: route.method, path: route.path }));
}

function routeDetails(routes, overrides) {
  const counts = new Map();
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return routes.map((route) => ({
    method: route.method,
    path: route.path,
    requestId: route.requestId,
    requestName: route.requestName,
    scenarioCount: route.mock.scenarios.length,
    scenarios: route.mock.scenarios.map((s) => ({
      id: s.id,
      name: s.name,
      isDefault: s.isDefault,
    })),
    mode: route.mock.mode,
    activeScenarioId: route.mock.activeScenarioId,
    runtimeScenarioId: overrides.get(route.requestId) || null,
    duplicate: counts.get(`${route.method} ${route.path}`) > 1,
  }));
}

function responseFromScenario(scenario, ctx) {
  const headers = {};
  for (const [key, value] of headerPairs(scenario.headers)) {
    if (key.toLowerCase() === 'content-length') continue;
    headers[key] = value;
  }
  if (scenario.contentType && !hasHeader(headers, 'content-type')) {
    headers['Content-Type'] = scenario.contentType;
  }
  return {
    status: clampStatus(scenario.status),
    headers,
    body: renderMockTemplate(scenario.body, ctx),
    delayMs: clampDelay(scenario.delayMs),
  };
}

function responseFromExample(example) {
  const saved = example?.response || {};
  const headers = {};
  for (const [key, value] of headerPairs(saved.headers)) {
    if (key.toLowerCase() === 'content-length') continue;
    headers[key] = value;
  }
  if (saved.contentType && !hasHeader(headers, 'content-type')) {
    headers['Content-Type'] = String(saved.contentType);
  }
  let text = saved.body;
  if (text == null) text = '';
  else if (typeof text !== 'string') {
    text = typeof text === 'object' ? JSON.stringify(text) : String(text);
  }
  return { status: clampStatus(saved.status), headers, body: text, delayMs: 0 };
}

/**
 * @returns {Promise<{ok:boolean, port:number|null, url:string, routes:Array,
 *   stop:() => Promise<void>, getLogs:() => Array, getRoutes:() => Array,
 *   setRoutes:(collections:Array)=>Array, selectScenario:(requestId:string,
 *   scenarioId:string|null)=>boolean, error?:string}>}
 */
export function startMockServer({
  collections = [],
  port = 0,
  delayMs = 0,
  host = '127.0.0.1',
  onLog,
} = {}) {
  const serverDelay = clampDelay(delayMs);
  const bindHost = String(host || '127.0.0.1');

  let routes = buildRoutes(collections);
  let sortedRoutes = sortRoutes(routes);
  let routesSummary = routeList(routes);
  const overrides = new Map();
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

  function setRoutes(nextCollections) {
    routes = buildRoutes(nextCollections);
    sortedRoutes = sortRoutes(routes);
    routesSummary = routeList(routes);
    for (const [id, scenarioId] of [...overrides.entries()]) {
      const route = routes.find((r) => r.requestId === id);
      if (!route || !route.mock.scenarios.some((s) => s.id === scenarioId)) {
        overrides.delete(id);
      }
    }
    return routeDetails(routes, overrides);
  }

  function selectRouteScenario(requestId, scenarioId) {
    const route = routes.find((r) => r.requestId === String(requestId));
    if (!route) return false;
    if (scenarioId == null || scenarioId === '') {
      overrides.delete(route.requestId);
      return true;
    }
    if (!route.mock.scenarios.some((s) => s.id === String(scenarioId))) return false;
    overrides.set(route.requestId, String(scenarioId));
    return true;
  }

  const sockets = new Set();
  const timers = new Set();
  let closing = null;

  const server = http.createServer((req, res) => {
    const startedAt = Date.now();
    const startedHr = process.hrtime.bigint();
    const method = String(req.method || 'GET').toUpperCase();
    const parsedUrl = new URL(req.url || '/', `http://${bindHost}`);
    const path = normalizePath(parsedUrl.pathname);

    const respondBase = (status, headers, body, extraLog) => {
      if (res.destroyed || res.writableEnded || server.listening === false) return;
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '', 'utf8');
      const capped =
        buffer.length > MAX_RESPONSE_BYTES ? buffer.subarray(0, MAX_RESPONSE_BYTES) : buffer;
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
        ...(extraLog || {}),
      });
    };

    const respond = (status, headers, body, extraLog, waitMs = 0) => {
      if (waitMs > 0) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          respondBase(status, headers, body, extraLog);
        }, waitMs);
        if (typeof timer.unref === 'function') timer.unref();
        timers.add(timer);
        return;
      }
      respondBase(status, headers, body, extraLog);
    };

    // CORS preflight is answered before route matching so any path works.
    if (method === 'OPTIONS') {
      req.resume();
      const headers = {};
      applyCors(headers);
      respond(204, headers, '');
      return;
    }

    const matched = matchRoutes(sortedRoutes, method, path);
    if (!matched) {
      req.resume();
      const headers = { 'Content-Type': 'application/json; charset=utf-8' };
      applyCors(headers);
      respond(
        404,
        headers,
        jsonBody({
          error: 'No mock route matched',
          method,
          path,
          routes: routesSummary,
        })
      );
      return;
    }

    const { route, params } = matched;
    const overrideId = overrides.get(route.requestId) || null;
    const effectiveMock = overrideId
      ? { ...route.mock, mode: 'manual', activeScenarioId: overrideId }
      : route.mock;

    (async () => {
      let body = null;
      if (configNeedsBody(effectiveMock)) {
        const text = await readBody(req);
        body = parseJsonBody(text, req.headers['content-type']);
      } else {
        req.resume();
      }

      const ctx = {
        query: parsedUrl.searchParams,
        headers: req.headers,
        body,
        path: params,
      };
      const selected = selectScenario(effectiveMock, ctx);
      const scenario = selected?.scenario || null;

      let response;
      if (scenario) {
        response = responseFromScenario(scenario, ctx);
      } else {
        const examples = Array.isArray(route.request.examples) ? route.request.examples : [];
        const example = examples.length ? examples[examples.length - 1] : null;
        if (!example) {
          const headers = { 'Content-Type': 'application/json; charset=utf-8' };
          applyCors(headers);
          respond(
            501,
            headers,
            jsonBody({
              error: 'No saved example for this route',
              method,
              path,
            }),
            scenario
              ? { matched: true, scenarioId: scenario.id, scenarioName: scenario.name }
              : undefined
          );
          return;
        }
        response = responseFromExample(example);
      }

      applyCors(response.headers);
      const wait = response.delayMs > 0 ? response.delayMs : serverDelay;
      respond(
        response.status,
        response.headers,
        response.body,
        scenario
          ? {
              matched: true,
              scenarioId: scenario.id,
              scenarioName: scenario.name,
              reason: selected?.reason || '',
            }
          : undefined,
        wait
      );
    })().catch(() => {
      // Never let a malformed request (or handler bug) crash the host app.
      try {
        const headers = { 'Content-Type': 'application/json; charset=utf-8' };
        applyCors(headers);
        respond(500, headers, jsonBody({ error: 'Mock handler failed' }));
      } catch {
        /* ignore */
      }
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const requestedPort = Number(port);
  const listenPort =
    Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65535
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
        routes: routesSummary,
        error: error?.message || String(error),
        stop,
        getLogs: () => logs.map((entry) => ({ ...entry })),
        getRoutes: () => routeDetails(routes, overrides),
        setRoutes,
        selectScenario: selectRouteScenario,
      });
    };

    const onListening = () => {
      if (settled) return;
      settled = true;
      server.removeListener('error', fail);
      server.on('error', () => {});
      const address = server.address();
      const actualPort = address && typeof address === 'object' ? address.port : null;
      resolve({
        ok: true,
        port: actualPort,
        url: `http://${bindHost}:${actualPort}`,
        routes: routesSummary,
        stop,
        getLogs: () => logs.map((entry) => ({ ...entry })),
        getRoutes: () => routeDetails(routes, overrides),
        setRoutes,
        selectScenario: selectRouteScenario,
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
