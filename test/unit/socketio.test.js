import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSocketIoManager } from '../../electron/protocols/socketio.js';

function stubSocket() {
  const handlers = new Map();
  let anyHandler = null;

  const socket = {
    id: 'sock-123',
    connected: false,
    io: { engine: { transport: { name: 'websocket' } } },
    emit: vi.fn(),
  };

  socket.on = vi.fn((event, handler) => {
    const list = handlers.get(event) || [];
    list.push(handler);
    handlers.set(event, list);
    return socket;
  });
  socket.onAny = vi.fn((handler) => {
    anyHandler = handler;
    return socket;
  });
  socket.disconnect = vi.fn(() => {
    socket.connected = false;
    socket.fire('disconnect', 'io client disconnect');
  });
  socket.fire = (event, ...args) => {
    for (const handler of handlers.get(event) || []) handler(...args);
  };
  socket.fireAny = (event, ...args) => anyHandler?.(event, ...args);

  return socket;
}

function harness() {
  const sockets = [];
  const connect = vi.fn((url, options) => {
    const socket = stubSocket();
    sockets.push({ socket, url, options });
    return socket;
  });
  return { manager: createSocketIoManager({ connect }), connect, sockets };
}

function collector() {
  const events = [];
  return { events, onEvent: (event) => events.push(event) };
}

async function openConnected(h, overrides = {}) {
  const sink = collector();
  const pending = h.manager.openSession({
    id: 's',
    url: 'socketio://localhost:3000',
    onEvent: sink.onEvent,
    ...overrides,
  });
  const socket = h.sockets[h.sockets.length - 1].socket;
  socket.connected = true;
  socket.fire('connect');
  await pending;
  return { socket, sink };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('socket.io manager', () => {
  it('normalises explicit schemes to http(s) and passes auth/headers', async () => {
    const h = harness();
    const { sink } = await openConnected(h, {
      url: 'socketio://localhost:3000',
      auth: { token: 'secret' },
      headers: { 'X-Test': '1' },
    });

    expect(h.connect).toHaveBeenCalledWith(
      'http://localhost:3000',
      expect.objectContaining({
        auth: { token: 'secret' },
        extraHeaders: { 'X-Test': '1' },
        reconnection: false,
        forceNew: true,
        timeout: 10000,
      })
    );
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        type: 'connect',
        socketId: 'sock-123',
        transport: 'websocket',
      })
    );
    h.manager.closeAll();
  });

  it('maps every explicit Socket.IO scheme and accepts http(s) directly', async () => {
    const cases = [
      ['socketios://localhost:3000', 'https://localhost:3000'],
      ['socket.io://localhost:3000', 'http://localhost:3000'],
      ['io://localhost:3000', 'http://localhost:3000'],
      ['https://localhost:3000', 'https://localhost:3000'],
    ];

    for (const [input, expected] of cases) {
      const h = harness();
      const pending = h.manager.openSession({
        id: 's',
        url: input,
        onEvent: () => {},
      });
      const socket = h.sockets[0].socket;
      socket.connected = true;
      socket.fire('connect');
      await pending;
      expect(h.sockets[0].url).toBe(expected);
      h.manager.closeAll();
    }
  });

  it('captures all server events through onAny', async () => {
    const h = harness();
    const { socket, sink } = await openConnected(h);

    socket.fireAny('chat message', { text: 'hi' }, 2);
    const message = sink.events.find((e) => e.type === 'message');
    expect(message).toMatchObject({
      type: 'message',
      event: 'chat message',
      args: [{ text: 'hi' }, 2],
    });
    expect(typeof message.at).toBe('number');

    h.manager.closeAll();
  });

  it('emits with an argument array and wraps a single value', async () => {
    const h = harness();
    const { socket } = await openConnected(h);

    await h.manager.emit('s', 'chat', [{ body: 'hello' }, 'x']);
    expect(socket.emit).toHaveBeenCalledWith('chat', { body: 'hello' }, 'x');

    await h.manager.emit('s', 'ping', 'pong');
    expect(socket.emit).toHaveBeenLastCalledWith('ping', 'pong');

    await h.manager.emit('s', 'empty');
    expect(socket.emit).toHaveBeenLastCalledWith('empty');

    h.manager.closeAll();
  });

  it('normalises server and client disconnects', async () => {
    const h = harness();
    const { socket, sink } = await openConnected(h);

    socket.fire('disconnect', 'transport close');
    const event = sink.events.find((e) => e.type === 'disconnect');
    expect(event).toMatchObject({ type: 'disconnect', reason: 'transport close' });
    expect(typeof event.at).toBe('number');
    expect(await h.manager.emit('s', 'late')).toBe(false);
  });

  it('rejects invalid and unsupported URLs with a clear error', async () => {
    const { manager } = harness();
    await expect(manager.openSession({ id: 's', url: '' })).rejects.toThrow(
      /Socket.IO URL is required/
    );
    await expect(manager.openSession({ id: 's', url: 'nope' })).rejects.toThrow(
      /Invalid Socket.IO URL/
    );
    await expect(
      manager.openSession({ id: 's', url: 'ftp://localhost:3000' })
    ).rejects.toThrow(/Socket.IO URL must start with/);
  });

  it('rejects with the connect_error message and emits an error event', async () => {
    const h = harness();
    const sink = collector();
    const pending = h.manager.openSession({
      id: 's',
      url: 'socketio://localhost:3000',
      onEvent: sink.onEvent,
      connectTimeoutMs: 50,
    });
    h.sockets[0].socket.fire('connect_error', new Error('unauthorized'));
    await expect(pending).rejects.toThrow(/Socket.IO connection failed: unauthorized/);
    expect(sink.events).toContainEqual(
      expect.objectContaining({ type: 'error', message: 'unauthorized' })
    );
  });

  it('times out a connection that never opens', async () => {
    const h = harness();
    await expect(
      h.manager.openSession({
        id: 's',
        url: 'socketio://localhost:3000',
        connectTimeoutMs: 20,
      })
    ).rejects.toThrow(/timed out after 20ms/);
    expect(h.sockets[0].socket.disconnect).toHaveBeenCalled();
  });

  it('rejects a connection closed before it opens', async () => {
    const h = harness();
    const pending = h.manager.openSession({
      id: 's',
      url: 'socketio://localhost:3000',
    });
    const assertion = expect(pending).rejects.toThrow(/disconnected before connecting/);
    await h.manager.closeSession('s');
    await assertion;
  });

  it('caps history at 500 messages and counts drops', async () => {
    const h = harness();
    const { socket } = await openConnected(h);

    for (let i = 0; i < 505; i += 1) socket.fireAny('tick', i);

    const history = h.manager.getHistory('s');
    expect(history).toHaveLength(500);
    expect(history.dropped).toBe(5);
    expect(history[0].args).toEqual([5]);
    expect(history[499].args).toEqual([504]);
    h.manager.closeAll();
  });

  it('caps history at 1 MB and counts drops', async () => {
    const h = harness();
    const { socket } = await openConnected(h);

    const chunk = 'a'.repeat(300 * 1024);
    for (let i = 0; i < 4; i += 1) socket.fireAny('big', chunk);

    const history = h.manager.getHistory('s');
    expect(history).toHaveLength(3);
    expect(history.dropped).toBe(1);
    expect(history.bytes).toBeLessThanOrEqual(1024 * 1024);
    h.manager.closeAll();
  });

  it('closes a session, forgets its history, and ignores unknown ids', async () => {
    const h = harness();
    const { socket } = await openConnected(h);
    socket.fireAny('x', 1);
    expect(h.manager.getHistory('s')).toHaveLength(1);

    expect(await h.manager.closeSession('s')).toBe(true);
    expect(socket.disconnect).toHaveBeenCalled();
    expect(h.manager.getHistory('s')).toHaveLength(0);
    expect(await h.manager.closeSession('s')).toBe(false);
    expect(await h.manager.emit('missing', 'x', [])).toBe(false);
  });

  it('closeAll disconnects every session and is idempotent', async () => {
    const h = harness();
    const first = await openConnected(h);
    first.socket.fireAny('a', 1);

    const sink = collector();
    const pending = h.manager.openSession({
      id: 'other',
      url: 'io://localhost:4000',
      onEvent: sink.onEvent,
    });
    const second = h.sockets[1].socket;
    second.connected = true;
    second.fire('connect');
    await pending;

    h.manager.closeAll();
    expect(first.socket.disconnect).toHaveBeenCalled();
    expect(second.disconnect).toHaveBeenCalled();
    expect(h.manager.getHistory('s')).toHaveLength(0);
    expect(h.manager.getHistory('other')).toHaveLength(0);
    expect(() => h.manager.closeAll()).not.toThrow();
  });

  it('never logs auth payloads or headers', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const h = harness();
    const pending = h.manager.openSession({
      id: 's',
      url: 'socketio://localhost:3000',
      auth: { token: 'super-secret-token' },
      headers: { Authorization: 'Bearer super-secret-token' },
      connectTimeoutMs: 50,
    });
    h.sockets[0].socket.fire('connect_error', new Error('unauthorized'));
    await expect(pending).rejects.toThrow(/unauthorized/);

    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('Socket.IO URL detection rule', () => {
  it('uses only explicit schemes, never an http(s) marker', async () => {
    const { protocolFor, isSocketIo } = await import('../../src/lib/protocol.js');
    const { protocolFor: mainProtocolFor } = await import('../../electron/protocols/index.js');

    for (const input of ['socketio://h', 'socketios://h', 'socket.io://h', 'io://h']) {
      expect(protocolFor(input)).toBe('socketio');
      expect(mainProtocolFor(input)).toBe('socketio');
      expect(isSocketIo(input)).toBe(true);
    }

    expect(protocolFor('http://localhost:3000/socket.io')).toBe('http');
    expect(mainProtocolFor('http://localhost:3000/socket.io')).toBe('http');
    expect(protocolFor('https://localhost:3000/?io=1')).toBe('https');
    expect(isSocketIo('https://localhost:3000')).toBe(false);
  });

  it('registers both adapters as stream transports', async () => {
    const { protocolFor } = await import('../../src/lib/protocol.js');
    const { getAdapter } = await import('../../electron/protocols/index.js');

    expect(protocolFor('mqtt://h')).toBe('mqtt');
    expect(protocolFor('mqtts://h')).toBe('mqtts');

    for (const scheme of ['mqtt', 'mqtts', 'socketio']) {
      const adapter = getAdapter(scheme);
      expect(adapter).toMatchObject({ id: scheme, kind: 'stream' });
      expect(typeof adapter.open).toBe('function');
      expect(typeof adapter.send).toBe('function');
      expect(typeof adapter.close).toBe('function');
      expect(typeof adapter.history).toBe('function');
    }
  });
});
