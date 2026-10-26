// gRPC transport. All proto loading and calls live in the main process; the
// renderer only sends JSON-shaped payloads and receives plain objects.
//
// Supported in this phase:
//   - .proto files on disk (no server reflection).
//   - unary calls (30 s deadline).
//   - server-streaming calls (no deadline; cancel via `cancelStream`).
//
// Deliberately out of scope: server reflection, client streaming, bidi
// streaming, TLS client certificates, per-call compression settings.
//
// Contract:
//   loadServices({ protoPath, reflection? })
//     -> { ok, services: [{ name, methods: [{ name, requestType,
//          responseType, streaming: 'unary'|'server'|'client'|'bidi' }] }],
//          error? }
//   invokeUnary({ target, protoPath, service, method, message, metadata, tls })
//     -> { ok, response, metadata?, durationMs, error? }
//   startServerStream({ id, target, protoPath, service, method, message,
//                       metadata, tls, onEvent })
//     -> { ok, error? }   events: data/end/error, each with `at`
//   cancelStream(id) -> boolean
//   closeAll() -> void
//
// Nothing here ever throws to the caller: every entry point resolves to a
// result object, so an IPC handler can return it without a try/catch dance.
// Messages, metadata values and credentials are never logged.

import fs from 'node:fs';
import path from 'node:path';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';

const UNARY_DEADLINE_MS = 30000;
const MAX_CACHED_DEFINITIONS = 32;
const REFLECTION_ERROR = 'Server reflection is not supported';

const LOADER_OPTIONS = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
};

const now = () => Date.now();

// protoPath -> { mtimeMs, size, loaded, services }. Protos are tiny, but
// re-parsing on every keystroke in the UI would still be wasteful.
const definitionCache = new Map();

// Renderer-generated stream ids -> { call, client, onEvent, ... }.
const streams = new Map();

function errMessage(err) {
  if (!err) return 'Unknown gRPC error';
  const detail = err.details || err.message || String(err);
  return err.code != null && !err.details ? `${detail} (code ${err.code})` : detail;
}

/**
 * Convert protobufjs/grpc-js values into JSON-safe data. Buffers become
 * base64 strings (the same convention as binary HTTP responses).
 */
function toPlain(value, depth = 0) {
  if (value == null) return value;
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return undefined;
  if (Array.isArray(value)) {
    if (depth > 20) return '[depth limit]';
    return value.map((item) => toPlain(item, depth + 1));
  }
  if (typeof value === 'object') {
    if (depth > 20) return '[depth limit]';
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = toPlain(item, depth + 1);
    }
    return out;
  }
  return value;
}

function metadataRows(metadata) {
  if (!metadata || typeof metadata.getMap !== 'function') return [];
  try {
    return Object.entries(metadata.getMap()).map(([key, value]) => ({
      key,
      value: String(value),
    }));
  } catch {
    return [];
  }
}

/**
 * Rows -> grpc.Metadata. Accepts `[{ key, value, enabled }]` or a plain
 * object. Rows without a key or explicitly disabled are skipped.
 */
function buildMetadata(rows) {
  const metadata = new grpc.Metadata();
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (!row || row.enabled === false) continue;
      const key = String(row.key || '').trim();
      if (!key) continue;
      metadata.set(key, String(row.value ?? ''));
    }
  } else if (rows && typeof rows === 'object') {
    for (const [key, value] of Object.entries(rows)) {
      if (!key || value == null) continue;
      metadata.set(key, String(value));
    }
  }
  return metadata;
}

function parseMessage(message) {
  if (message == null || message === '') return { ok: true, value: {} };
  if (typeof message === 'object') {
    if (Array.isArray(message)) return { ok: false, error: 'Message must be a JSON object' };
    return { ok: true, value: message };
  }
  if (typeof message !== 'string') {
    return { ok: false, error: 'Message must be JSON text or an object' };
  }
  const text = message.trim();
  if (!text) return { ok: true, value: {} };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'Message must be a JSON object' };
    }
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: `Invalid message JSON: ${err.message}` };
  }
}

/**
 * Normalise a renderer URL into a grpc-js target.
 * Accepts `host:port`, `grpc://host:port` and `grpcs://host:port`.
 */
export function normalizeTarget(raw) {
  const value = String(raw || '').trim();
  if (!value) return { target: '', tls: false, error: 'A gRPC target is required' };

  let rest = value;
  let tls = false;

  const withSlashes = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value);
  if (withSlashes) {
    const scheme = withSlashes[1].toLowerCase();
    if (scheme !== 'grpc' && scheme !== 'grpcs') {
      return { target: '', tls: false, error: `Unsupported gRPC scheme: ${scheme}` };
    }
    tls = scheme === 'grpcs';
    rest = value.slice(withSlashes[0].length);
  } else {
    // Bare scheme form: `grpc:127.0.0.1:50051`.
    const bare = /^(grpcs?):(.+)$/i.exec(value);
    if (bare) {
      tls = bare[1].toLowerCase() === 'grpcs';
      rest = bare[2];
    } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      return { target: '', tls: false, error: 'Unsupported gRPC target scheme' };
    }
  }

  // A target never has a path; strip a trailing slash or accidental path.
  const slash = rest.indexOf('/');
  if (slash >= 0) rest = rest.slice(0, slash);
  rest = rest.trim();
  if (!rest) return { target: '', tls: false, error: 'A gRPC target is required' };

  return { target: rest, tls };
}

function streamingKind(methodDef) {
  if (methodDef.requestStream && methodDef.responseStream) return 'bidi';
  if (methodDef.responseStream) return 'server';
  if (methodDef.requestStream) return 'client';
  return 'unary';
}

function typeName(typeDef) {
  return typeDef?.type?.name || typeDef?.name || '';
}

function collectServices(loaded) {
  const services = [];
  const visit = (node, prefix) => {
    for (const [key, value] of Object.entries(node || {})) {
      if (!value) continue;
      const fullName = prefix ? `${prefix}.${key}` : key;
      if (typeof value === 'function' && value.service) {
        const methods = Object.entries(value.service).map(([name, def]) => ({
          name,
          requestType: typeName(def.requestType),
          responseType: typeName(def.responseType),
          streaming: streamingKind(def),
        }));
        services.push({ name: fullName, methods });
      } else if (typeof value === 'object') {
        visit(value, fullName);
      }
    }
  };
  visit(loaded, '');
  services.sort((a, b) => a.name.localeCompare(b.name));
  for (const service of services) {
    service.methods.sort((a, b) => a.name.localeCompare(b.name));
  }
  return services;
}

function resolveProtoPath(protoPath) {
  const raw = String(protoPath || '').trim();
  if (!raw) return { error: 'A .proto file is required' };
  const absolute = path.resolve(raw);
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    return { error: `Cannot read .proto file: ${absolute}` };
  }
  if (!stat.isFile()) return { error: `Cannot read .proto file: ${absolute}` };
  return { absolute, mtimeMs: stat.mtimeMs, size: stat.size };
}

function loadDefinition(protoPath) {
  const resolved = resolveProtoPath(protoPath);
  if (resolved.error) return { error: resolved.error };

  const cached = definitionCache.get(resolved.absolute);
  if (cached && cached.mtimeMs === resolved.mtimeMs && cached.size === resolved.size) {
    return cached;
  }

  let loaded;
  try {
    const packageDefinition = protoLoader.loadSync(resolved.absolute, LOADER_OPTIONS);
    loaded = grpc.loadPackageDefinition(packageDefinition);
  } catch (err) {
    return { error: err?.message || String(err) };
  }

  const entry = {
    mtimeMs: resolved.mtimeMs,
    size: resolved.size,
    loaded,
    services: collectServices(loaded),
  };

  if (definitionCache.size >= MAX_CACHED_DEFINITIONS) {
    const oldest = definitionCache.keys().next().value;
    definitionCache.delete(oldest);
  }
  definitionCache.set(resolved.absolute, entry);
  return entry;
}

function findService(entry, serviceName) {
  const wanted = String(serviceName || '').trim().replace(/^\./, '');
  if (!wanted) return { error: 'A service name is required' };

  const all = [];
  const visit = (node, prefix) => {
    for (const [key, value] of Object.entries(node || {})) {
      if (!value) continue;
      const fullName = prefix ? `${prefix}.${key}` : key;
      if (typeof value === 'function' && value.service) all.push([fullName, value]);
      else if (typeof value === 'object') visit(value, fullName);
    }
  };
  visit(entry.loaded, '');

  const exact = all.find(([name]) => name === wanted);
  if (exact) return { name: exact[0], ctor: exact[1] };

  // Allow the short name (`Echo` for `relay.test.Echo`) when unambiguous.
  const suffix = all.filter(([name]) => name === wanted || name.endsWith(`.${wanted}`));
  if (suffix.length === 1) return { name: suffix[0][0], ctor: suffix[0][1] };
  if (suffix.length > 1) {
    return {
      error: `Service "${wanted}" is ambiguous: ${suffix.map(([name]) => name).join(', ')}`,
    };
  }
  return { error: `Service "${wanted}" was not found in the proto file` };
}

function findMethod(ctor, methodName) {
  const wanted = String(methodName || '').trim();
  if (!wanted) return { error: 'A method name is required' };
  const defs = ctor?.service || {};
  if (defs[wanted]) return { name: wanted, def: defs[wanted] };
  const ci = Object.keys(defs).find((name) => name.toLowerCase() === wanted.toLowerCase());
  if (ci) return { name: ci, def: defs[ci] };
  return { error: `Method "${wanted}" was not found in the selected service` };
}

function createClient(ctor, target, tls) {
  const credentials = tls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
  return new ctor(target, credentials);
}

function closeClient(client) {
  try {
    client.close();
  } catch {
    /* already closed */
  }
}

/**
 * Load a .proto file and describe its services. Never throws.
 * `reflection: true` is an explicit request for a feature this phase does not
 * implement; it returns the documented error instead of guessing.
 */
export function loadServices({ protoPath, reflection, useReflection } = {}) {
  if (reflection || useReflection) return { ok: false, error: REFLECTION_ERROR };
  const entry = loadDefinition(protoPath);
  if (entry.error) return { ok: false, error: entry.error };
  return { ok: true, services: entry.services };
}

/**
 * Unary call. `message` is JSON text or an object; `metadata` is
 * `[{ key, value, enabled }]`. `tls: true` enables TLS (a `grpcs://` target
 * implies it unless `tls` is an explicit boolean).
 */
export function invokeUnary({
  target,
  protoPath,
  service,
  method,
  message,
  metadata,
  tls,
  reflection,
} = {}) {
  const started = now();
  const fail = (error) => ({ ok: false, error, durationMs: now() - started });

  if (reflection) return fail(REFLECTION_ERROR);

  const normalized = normalizeTarget(target);
  if (normalized.error) return fail(normalized.error);

  const entry = loadDefinition(protoPath);
  if (entry.error) return fail(entry.error);

  const foundService = findService(entry, service);
  if (foundService.error) return fail(foundService.error);

  const foundMethod = findMethod(foundService.ctor, method);
  if (foundMethod.error) return fail(foundMethod.error);

  const kind = streamingKind(foundMethod.def);
  if (kind !== 'unary') {
    return fail(
      `Method "${foundMethod.name}" is ${kind === 'server' ? 'server-streaming' : `${kind}-streaming`}; use Stream instead`
    );
  }

  const parsed = parseMessage(message);
  if (!parsed.ok) return fail(parsed.error);

  const useTls = typeof tls === 'boolean' ? tls : normalized.tls;
  let client;
  try {
    client = createClient(foundService.ctor, normalized.target, useTls);
  } catch (err) {
    return fail(err?.message || String(err));
  }

  return new Promise((resolve) => {
    let settled = false;
    let responseMetadata = [];
    const finish = (result) => {
      if (settled) return;
      settled = true;
      closeClient(client);
      resolve(result);
    };

    try {
      const call = client[foundMethod.name](
        parsed.value,
        buildMetadata(metadata),
        { deadline: new Date(Date.now() + UNARY_DEADLINE_MS) },
        (err, response) => {
          if (err) {
            finish({
              ok: false,
              error: errMessage(err),
              code: err.code,
              durationMs: now() - started,
            });
            return;
          }
          finish({
            ok: true,
            response: toPlain(response),
            metadata: responseMetadata,
            durationMs: now() - started,
          });
        }
      );
      call?.on?.('metadata', (md) => {
        responseMetadata = metadataRows(md);
      });
    } catch (err) {
      finish({ ok: false, error: err?.message || String(err), durationMs: now() - started });
    }
  });
}

/**
 * Start a server-streaming call. Returns as soon as the call is created; every
 * response message and the terminal state arrive through `onEvent`:
 *   { type: 'data', message, at }
 *   { type: 'end', status?, at }
 *   { type: 'error', message, at }
 */
export function startServerStream({
  id,
  target,
  protoPath,
  service,
  method,
  message,
  metadata,
  tls,
  onEvent,
} = {}) {
  const sessionId = typeof id === 'string' ? id.trim() : '';
  if (!sessionId) return { ok: false, error: 'A stream id is required' };

  const normalized = normalizeTarget(target);
  if (normalized.error) return { ok: false, error: normalized.error };

  const entry = loadDefinition(protoPath);
  if (entry.error) return { ok: false, error: entry.error };

  const foundService = findService(entry, service);
  if (foundService.error) return { ok: false, error: foundService.error };

  const foundMethod = findMethod(foundService.ctor, method);
  if (foundMethod.error) return { ok: false, error: foundMethod.error };

  const kind = streamingKind(foundMethod.def);
  if (kind !== 'server') {
    return {
      ok: false,
      error:
        kind === 'unary'
          ? `Method "${foundMethod.name}" is unary; use Invoke instead`
          : `Method "${foundMethod.name}" is ${kind}-streaming; only server streaming is supported`,
    };
  }

  const parsed = parseMessage(message);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  // Replacing the same renderer id must not leak the previous call.
  if (streams.has(sessionId)) cancelStream(sessionId);

  const useTls = typeof tls === 'boolean' ? tls : normalized.tls;
  const session = {
    id: sessionId,
    onEvent,
    call: null,
    client: null,
    settled: false,
  };

  const emit = (event) => {
    if (session.settled) return;
    try {
      session.onEvent?.(event);
    } catch {
      /* a renderer callback must never take the stream down */
    }
  };

  const cleanup = () => {
    streams.delete(sessionId);
    closeClient(session.client);
  };

  try {
    session.client = createClient(foundService.ctor, normalized.target, useTls);
    const call = session.client[foundMethod.name](
      parsed.value,
      buildMetadata(metadata)
    );
    session.call = call;
    streams.set(sessionId, session);

    let status = null;

    call.on('data', (payload) => {
      emit({ type: 'data', message: toPlain(payload), at: now() });
    });
    call.on('status', (received) => {
      if (!received) return;
      status = { code: received.code, details: received.details };
    });
    call.on('error', (err) => {
      if (session.settled) return;
      // Emit before flipping `settled`; `emit` itself drops late events.
      emit({ type: 'error', message: errMessage(err), at: now() });
      session.settled = true;
      cleanup();
    });
    call.on('end', () => {
      if (session.settled) return;
      emit({
        type: 'end',
        status: status || { code: 0, details: 'OK' },
        at: now(),
      });
      session.settled = true;
      cleanup();
    });
  } catch (err) {
    session.settled = true;
    streams.delete(sessionId);
    closeClient(session.client);
    return { ok: false, error: err?.message || String(err) };
  }

  return { ok: true };
}

/**
 * Cancel one stream. Cancelled streams emit no further events; the renderer
 * marks the log as stopped locally. Returns false for an unknown id.
 */
export function cancelStream(id) {
  const session = streams.get(String(id || ''));
  if (!session) return false;
  session.settled = true;
  streams.delete(session.id);
  try {
    session.call?.cancel?.();
  } catch {
    /* already finished */
  }
  closeClient(session.client);
  return true;
}

/** Cancel every open stream (app shutdown). Safe to call repeatedly. */
export function closeAll() {
  for (const id of [...streams.keys()]) cancelStream(id);
}
