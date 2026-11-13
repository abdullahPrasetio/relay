// gRPC transport. All proto loading and calls live in the main process; the
// renderer only sends JSON-shaped payloads and receives plain objects.
//
// Supported:
//   - .proto files on disk or server reflection.
//   - unary calls (30 s deadline).
//   - server, client, and bidi streaming (no deadline; cancel via `cancelStream`).
//
// Deliberately out of scope: TLS client certificates and per-call compression
// settings.
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
import { Client as ReflectionClient } from 'grpc-reflection-js';

const UNARY_DEADLINE_MS = 30000;
const MAX_CACHED_DEFINITIONS = 32;
const REFLECTION_CACHE_LIMIT = 16;
const reflectionCache = new Map();

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

const PLAIN_OPTIONS = {
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
};

function genericClientForService(root, service) {
  const definitions = {};
  for (const [name, method] of Object.entries(service.methods || {})) {
    const requestType = method.resolvedRequestType;
    const responseType = method.resolvedResponseType;
    if (!requestType || !responseType) continue;
    definitions[name] = {
      path: `/${String(service.fullName || '').replace(/^\./, '')}/${name}`,
      requestStream: !!method.requestStream,
      responseStream: !!method.responseStream,
      requestSerialize: (value) =>
        Buffer.from(requestType.encode(requestType.fromObject(value)).finish()),
      requestDeserialize: (buffer) =>
        requestType.toObject(requestType.decode(buffer), PLAIN_OPTIONS),
      responseSerialize: (value) =>
        Buffer.from(responseType.encode(responseType.fromObject(value)).finish()),
      responseDeserialize: (buffer) =>
        responseType.toObject(responseType.decode(buffer), PLAIN_OPTIONS),
    };
  }
  return grpc.makeGenericClientConstructor(definitions, service.fullName);
}

function serviceDescriptor(root, fullName) {
  const clean = String(fullName || '').replace(/^\./, '');
  try {
    return root.lookupService(clean);
  } catch {
    return null;
  }
}

async function reflectionDefinition(target, tls) {
  const normalized = normalizeTarget(target);
  if (normalized.error) return { error: normalized.error };
  const useTls = typeof tls === 'boolean' ? tls : normalized.tls;
  const key = `${normalized.target}|${useTls ? 'tls' : 'plain'}`;
  const cached = reflectionCache.get(key);
  if (cached) return cached;

  const credentials = useTls
    ? grpc.credentials.createSsl()
    : grpc.credentials.createInsecure();
  const client = new ReflectionClient(normalized.target, credentials);
  try {
    const names = await client.listServices();
    const services = [];
    const roots = new Map();
    for (const rawName of names) {
      const name = String(rawName || '').replace(/^\./, '');
      if (!name || name.startsWith('grpc.reflection.')) continue;
      let root;
      try {
        root = await client.fileContainingSymbol(name);
      } catch {
        continue;
      }
      const service = serviceDescriptor(root, name);
      if (!service) continue;
      roots.set(name, root);
      services.push({
        name,
        methods: Object.entries(service.methods || {}).map(([methodName, def]) => ({
          name: methodName,
          requestType: def.resolvedRequestType?.name || '',
          responseType: def.resolvedResponseType?.name || '',
          streaming: streamingKind(def),
        })),
      });
    }
    services.sort((a, b) => a.name.localeCompare(b.name));
    for (const service of services) {
      service.methods.sort((a, b) => a.name.localeCompare(b.name));
    }
    const entry = { reflection: true, services, roots, ctors: new Map() };
    if (reflectionCache.size >= REFLECTION_CACHE_LIMIT) {
      reflectionCache.delete(reflectionCache.keys().next().value);
    }
    reflectionCache.set(key, entry);
    return entry;
  } catch (err) {
    return { error: `Server reflection failed: ${err?.message || String(err)}` };
  } finally {
    try {
      client.grpcClient?.close?.();
    } catch {
      /* best effort */
    }
  }
}

async function getDefinition({ protoPath, reflection, target, tls } = {}) {
  if (reflection) return reflectionDefinition(target, tls);
  return loadDefinition(protoPath);
}

function findService(entry, serviceName) {
  const wanted = String(serviceName || '').trim().replace(/^\./, '');
  if (!wanted) return { error: 'A service name is required' };

  if (entry.reflection) {
    const exact = entry.services.find((service) => service.name === wanted);
    const suffix = entry.services.filter(
      (service) => service.name === wanted || service.name.endsWith(`.${wanted}`)
    );
    const match = exact || (suffix.length === 1 ? suffix[0] : null);
    if (!match) {
      if (suffix.length > 1) {
        return {
          error: `Service "${wanted}" is ambiguous: ${suffix
            .map((service) => service.name)
            .join(', ')}`,
        };
      }
      return { error: `Service "${wanted}" was not found via reflection` };
    }
    const root = entry.roots.get(match.name);
    const service = root && serviceDescriptor(root, match.name);
    if (!service) return { error: `Service "${match.name}" descriptor is unavailable` };
    let ctor = entry.ctors.get(match.name);
    if (!ctor) {
      ctor = genericClientForService(root, service);
      entry.ctors.set(match.name, ctor);
    }
    return { name: match.name, ctor };
  }

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
export async function loadServices({
  protoPath,
  reflection,
  useReflection,
  target,
  tls,
} = {}) {
  const entry = await getDefinition({
    protoPath,
    reflection: reflection || useReflection,
    target,
    tls,
  });
  if (entry.error) return { ok: false, error: entry.error };
  return { ok: true, services: entry.services };
}

/**
 * Unary call. `message` is JSON text or an object; `metadata` is
 * `[{ key, value, enabled }]`. `tls: true` enables TLS (a `grpcs://` target
 * implies it unless `tls` is an explicit boolean).
 */
export async function invokeUnary({
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

  const normalized = normalizeTarget(target);
  if (normalized.error) return fail(normalized.error);

  const entry = await getDefinition({ protoPath, reflection, target, tls });
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
export async function startServerStream({
  id,
  target,
  protoPath,
  service,
  method,
  message,
  metadata,
  tls,
  reflection,
  onEvent,
} = {}) {
  const sessionId = typeof id === 'string' ? id.trim() : '';
  if (!sessionId) return { ok: false, error: 'A stream id is required' };

  const normalized = normalizeTarget(target);
  if (normalized.error) return { ok: false, error: normalized.error };

  const entry = await getDefinition({ protoPath, reflection, target, tls });
  if (entry.error) return { ok: false, error: entry.error };

  const foundService = findService(entry, service);
  if (foundService.error) return { ok: false, error: foundService.error };

  const foundMethod = findMethod(foundService.ctor, method);
  if (foundMethod.error) return { ok: false, error: foundMethod.error };

  const kind = streamingKind(foundMethod.def);
  if (kind === 'unary') {
    return { ok: false, error: `Method "${foundMethod.name}" is unary; use Invoke instead` };
  }

  const parsed = parseMessage(message);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  if (streams.has(sessionId)) cancelStream(sessionId);

  const useTls = typeof tls === 'boolean' ? tls : normalized.tls;
  const session = {
    id: sessionId,
    kind,
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
    const grpcMetadata = buildMetadata(metadata);
    let call;
    if (kind === 'server') {
      call = session.client[foundMethod.name](parsed.value, grpcMetadata);
    } else if (kind === 'client') {
      call = session.client[foundMethod.name](grpcMetadata, {}, (err, response) => {
        if (session.settled) return;
        if (err) {
          emit({ type: 'error', message: errMessage(err), at: now() });
          session.settled = true;
          cleanup();
          return;
        }
        emit({ type: 'data', message: toPlain(response), at: now() });
        emit({
          type: 'end',
          status: { code: 0, details: 'OK' },
          at: now(),
        });
        session.settled = true;
        cleanup();
      });
    } else {
      call = session.client[foundMethod.name](grpcMetadata);
    }
    session.call = call;
    streams.set(sessionId, session);

    if (kind !== 'server' && parsed.value && Object.keys(parsed.value).length > 0) {
      call.write(parsed.value);
      emit({ type: 'sent', message: toPlain(parsed.value), at: now() });
    }

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
      emit({ type: 'error', message: errMessage(err), at: now() });
      session.settled = true;
      cleanup();
    });
    call.on('end', () => {
      if (session.settled) return;
      emit({ type: 'end', status: status || { code: 0, details: 'OK' }, at: now() });
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

/** Send one JSON message on a client/bidi stream. */
export function sendStream(id, message) {
  const session = streams.get(String(id || ''));
  if (!session || session.settled || !session.call) {
    return { ok: false, error: 'The stream is not open' };
  }
  if (session.kind === 'server') {
    return { ok: false, error: 'Server-streaming calls do not accept messages' };
  }
  const parsed = parseMessage(message);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  try {
    session.call.write(parsed.value);
    return { ok: true, message: toPlain(parsed.value) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/** Half-close a client/bidi stream; the server response still arrives. */
export function endStream(id) {
  const session = streams.get(String(id || ''));
  if (!session || session.settled || !session.call) {
    return { ok: false, error: 'The stream is not open' };
  }
  if (session.kind === 'server') {
    return { ok: false, error: 'Server-streaming calls are ended by the server' };
  }
  try {
    session.call.end();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
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
