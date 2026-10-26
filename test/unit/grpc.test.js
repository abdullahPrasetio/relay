import { fileURLToPath } from 'node:url';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadServices,
  invokeUnary,
  startServerStream,
  cancelStream,
  closeAll,
  normalizeTarget,
} from '../../electron/protocols/grpc.js';
import { protocolFor as mainProtocolFor, getAdapter } from '../../electron/protocols/index.js';
import { isGrpc, isGrpcTls, protocolFor as uiProtocolFor } from '../../src/lib/protocol.js';

const PROTO_PATH = fileURLToPath(new URL('../fixtures/grpc/echo.proto', import.meta.url));

const cleanups = [];

const LOADER_OPTIONS = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
};

async function startServer({ delayMs = 0 } = {}) {
  const packageDefinition = protoLoader.loadSync(PROTO_PATH, LOADER_OPTIONS);
  const loaded = grpc.loadPackageDefinition(packageDefinition);

  const server = new grpc.Server();
  server.addService(loaded.relay.test.Echo.service, {
    Say(call, callback) {
      const token = call.metadata.get('x-token')[0] || '';
      callback(null, {
        message: `${call.request.message}|${token}`,
        count: Number(call.request.count) || 0,
      });
    },
    Count(call) {
      const total = Number(call.request.count) || 0;
      let sent = 0;
      const tick = () => {
        if (call.cancelled || sent >= total) {
          if (sent >= total && !call.cancelled) call.end();
          return;
        }
        sent += 1;
        call.write({ message: `${call.request.message} ${sent}`, count: sent });
        if (sent >= total) call.end();
        else if (delayMs > 0) setTimeout(tick, delayMs);
        else tick();
      };
      if (total > 0) tick();
      else call.end();
    },
  });

  const port = await new Promise((resolve, reject) => {
    server.bindAsync(
      '127.0.0.1:0',
      grpc.ServerCredentials.createInsecure(),
      (err, boundPort) => (err ? reject(err) : resolve(boundPort))
    );
  });

  cleanups.push(async () => {
    await new Promise((resolve) => {
      server.tryShutdown(() => resolve());
      setTimeout(() => {
        server.forceShutdown();
        resolve();
      }, 250).unref?.();
    });
  });

  return { server, port, target: `127.0.0.1:${port}` };
}

function collector() {
  const events = [];
  const listeners = new Set();

  function onEvent(event) {
    events.push(event);
    for (const listener of [...listeners]) listener(event);
  }

  function waitFor(predicate, timeout = 3000) {
    const existing = events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error('timed out waiting for gRPC stream event'));
      }, timeout);
      const listener = (event) => {
        if (!predicate(event)) return;
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(event);
      };
      listeners.add(listener);
    });
  }

  return { events, onEvent, waitFor };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  closeAll();
  while (cleanups.length) await cleanups.pop()();
});

describe('gRPC protocol detection', () => {
  it('normalises grpc:// and grpcs:// to one protocol id', () => {
    for (const fn of [mainProtocolFor, uiProtocolFor]) {
      expect(fn('grpc://127.0.0.1:50051')).toBe('grpc');
      expect(fn('grpcs://api.example.com:443')).toBe('grpc');
      expect(fn('grpc:127.0.0.1:50051')).toBe('grpc');
      expect(fn('https://example.com')).toBe('https');
      expect(fn('ws://example.com')).toBe('ws');
    }
    expect(isGrpc('grpcs://host:1')).toBe(true);
    expect(isGrpc('http://host')).toBe(false);
    expect(isGrpcTls('grpcs://host:1')).toBe(true);
    expect(isGrpcTls('grpc://host:1')).toBe(false);

    expect(getAdapter('grpc')).toMatchObject({ id: 'grpc', kind: 'stream' });
    expect(getAdapter('grpcs')).toMatchObject({ id: 'grpcs', kind: 'stream' });
    expect(typeof getAdapter('grpc').invoke).toBe('function');
  });
});

describe('gRPC proto loading', () => {
  it('lists services and classifies unary vs server-streaming methods', async () => {
    const result = await loadServices({ protoPath: PROTO_PATH });
    expect(result.ok).toBe(true);
    expect(result.services).toHaveLength(1);
    expect(result.services[0].name).toBe('relay.test.Echo');

    const byName = Object.fromEntries(
      result.services[0].methods.map((method) => [method.name, method])
    );
    expect(byName.Say).toMatchObject({
      requestType: 'EchoRequest',
      responseType: 'EchoReply',
      streaming: 'unary',
    });
    expect(byName.Count).toMatchObject({
      requestType: 'EchoRequest',
      responseType: 'EchoReply',
      streaming: 'server',
    });
  });

  it('returns an error object for a missing proto path', async () => {
    const missing = await loadServices({ protoPath: '/nope/missing.proto' });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/Cannot read \.proto file/);

    const empty = await loadServices({});
    expect(empty.ok).toBe(false);
    expect(typeof empty.error).toBe('string');
  });

  it('reports server reflection as unsupported', async () => {
    const result = await loadServices({ reflection: true });
    expect(result).toEqual({ ok: false, error: 'Server reflection is not supported' });

    const invoked = await invokeUnary({
      target: '127.0.0.1:1',
      protoPath: PROTO_PATH,
      service: 'relay.test.Echo',
      method: 'Say',
      message: '{}',
      reflection: true,
    });
    expect(invoked.ok).toBe(false);
    expect(invoked.error).toBe('Server reflection is not supported');
  });
});

describe('gRPC unary invoke', () => {
  it('calls a unary method and echoes metadata from a JSON message', async () => {
    const { target } = await startServer();

    const result = await invokeUnary({
      target,
      protoPath: PROTO_PATH,
      service: 'relay.test.Echo',
      method: 'Say',
      message: JSON.stringify({ message: 'hello', count: 1 }),
      metadata: [
        { key: 'x-token', value: 'secret' },
        { key: '', value: 'ignored' },
        { key: 'x-disabled', value: 'no', enabled: false },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.response).toEqual({ message: 'hello|secret', count: 1 });
    expect(Array.isArray(result.metadata)).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('accepts an object message and a short service name', async () => {
    const { target } = await startServer();
    const result = await invokeUnary({
      target,
      protoPath: PROTO_PATH,
      service: 'Echo',
      method: 'Say',
      message: { message: 'obj' },
    });
    expect(result.ok).toBe(true);
    expect(result.response.message).toBe('obj|');
  });

  it('accepts grpc:// and grpcs:// targets', async () => {
    const { target, port } = await startServer();
    const prefixed = await invokeUnary({
      target: `grpc://${target}`,
      protoPath: PROTO_PATH,
      service: 'relay.test.Echo',
      method: 'Say',
      message: { message: 'scheme' },
    });
    expect(prefixed.ok).toBe(true);
    expect(prefixed.response.message).toBe('scheme|');

    expect(normalizeTarget(`grpc://127.0.0.1:${port}`)).toEqual({
      target: `127.0.0.1:${port}`,
      tls: false,
    });
    expect(normalizeTarget(`grpcs://127.0.0.1:${port}`)).toEqual({
      target: `127.0.0.1:${port}`,
      tls: true,
    });
    expect(normalizeTarget(`grpc:127.0.0.1:${port}`).target).toBe(`127.0.0.1:${port}`);
    expect(normalizeTarget('https://example.com').error).toMatch(/Unsupported/);
    expect(normalizeTarget('').error).toMatch(/target is required/);
  });

  it('returns clear errors for unknown services, methods and bad JSON', async () => {
    const { target } = await startServer();
    const base = {
      target,
      protoPath: PROTO_PATH,
      service: 'relay.test.Echo',
      method: 'Say',
      message: '{}',
    };

    const noService = await invokeUnary({ ...base, service: 'Nope' });
    expect(noService.ok).toBe(false);
    expect(noService.error).toMatch(/Service "Nope" was not found/);

    const noMethod = await invokeUnary({ ...base, method: 'Missing' });
    expect(noMethod.ok).toBe(false);
    expect(noMethod.error).toMatch(/Method "Missing" was not found/);

    const badJson = await invokeUnary({ ...base, message: '{oops' });
    expect(badJson.ok).toBe(false);
    expect(badJson.error).toMatch(/Invalid message JSON/);

    const wrongKind = await invokeUnary({ ...base, method: 'Count' });
    expect(wrongKind.ok).toBe(false);
    expect(wrongKind.error).toMatch(/server-streaming/);
  });
});

describe('gRPC server streaming', () => {
  it('emits N data events then end', async () => {
    const { target } = await startServer();
    const { events, onEvent, waitFor } = collector();

    const started = startServerStream({
      id: 'stream-1',
      target,
      protoPath: PROTO_PATH,
      service: 'relay.test.Echo',
      method: 'Count',
      message: { message: 'tick', count: 3 },
      onEvent,
    });
    expect(started).toEqual({ ok: true });

    await waitFor((event) => event.type === 'end');

    const data = events.filter((event) => event.type === 'data');
    expect(data).toHaveLength(3);
    expect(data.map((event) => event.message.message)).toEqual([
      'tick 1',
      'tick 2',
      'tick 3',
    ]);
    expect(events[events.length - 1].type).toBe('end');
    expect(events[events.length - 1].status.code).toBe(0);
  });

  it('cancelStream stops further events and is idempotent', async () => {
    const { target } = await startServer({ delayMs: 20 });
    const { events, onEvent, waitFor } = collector();

    startServerStream({
      id: 'stream-cancel',
      target,
      protoPath: PROTO_PATH,
      service: 'relay.test.Echo',
      method: 'Count',
      message: { message: 'slow', count: 50 },
      onEvent,
    });

    await waitFor((event) => event.type === 'data');
    expect(cancelStream('stream-cancel')).toBe(true);
    expect(cancelStream('stream-cancel')).toBe(false);

    const countAtCancel = events.length;
    await delay(200);
    expect(events.length).toBe(countAtCancel);
    expect(events.some((event) => event.type === 'end')).toBe(false);
  });

  it('rejects unary methods and unknown ids on the stream API', async () => {
    const { target } = await startServer();
    const unary = startServerStream({
      id: 'stream-unary',
      target,
      protoPath: PROTO_PATH,
      service: 'relay.test.Echo',
      method: 'Say',
      message: '{}',
      onEvent: () => {},
    });
    expect(unary.ok).toBe(false);
    expect(unary.error).toMatch(/is unary/);

    const noId = startServerStream({
      target,
      protoPath: PROTO_PATH,
      service: 'relay.test.Echo',
      method: 'Count',
      message: '{}',
    });
    expect(noId.ok).toBe(false);

    expect(cancelStream('nope')).toBe(false);
  });
});
