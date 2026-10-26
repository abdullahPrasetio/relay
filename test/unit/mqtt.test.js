import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMqttManager } from '../../electron/protocols/mqtt.js';

function stubClient(options) {
  const client = new EventEmitter();
  client.options = { ...options };
  client.connected = false;
  client.publish = vi.fn((topic, payload, opts, cb) => {
    if (typeof opts === 'function') cb = opts;
    cb?.(null);
  });
  client.subscribe = vi.fn((topic, opts, cb) => {
    if (typeof opts === 'function') cb = opts;
    cb?.(null, [{ topic, qos: opts?.qos ?? 0 }]);
  });
  client.unsubscribe = vi.fn((topic, cb) => {
    cb?.(null);
  });
  client.end = vi.fn((force, opts, cb) => {
    if (typeof opts === 'function') cb = opts;
    cb?.();
  });
  return client;
}

function harness() {
  const clients = [];
  const calls = [];
  const connect = vi.fn((url, options) => {
    const client = stubClient(options);
    clients.push(client);
    calls.push({ url, options, client });
    return client;
  });
  return { manager: createMqttManager({ connect }), connect, clients, calls };
}

function collector() {
  const events = [];
  return { events, onEvent: (event) => events.push(event) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mqtt manager', () => {
  it('connects and emits a connect event with the client id', async () => {
    const { manager, calls } = harness();
    const { events, onEvent } = collector();
    const pending = manager.openSession({
      id: 's',
      url: 'mqtt://broker.test:1883',
      username: ' user ',
      password: 'secret',
      clientId: 'relay-1',
      keepalive: 30,
      clean: false,
      onEvent,
    });

    const client = calls[0].client;
    client.connected = true;
    client.emit('connect', { sessionPresent: false });
    await pending;

    expect(calls[0].url).toBe('mqtt://broker.test:1883');
    expect(calls[0].options).toMatchObject({
      username: ' user ',
      password: 'secret',
      clientId: 'relay-1',
      keepalive: 30,
      clean: false,
      reconnectPeriod: 0,
      connectTimeout: 10000,
    });

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'connect', clientId: 'relay-1' })
    );
    manager.closeAll();
  });

  it('rejects when the connection times out', async () => {
    const { manager, calls } = harness();
    await expect(
      manager.openSession({ id: 's', url: 'mqtt://broker.test', connectTimeoutMs: 20 })
    ).rejects.toThrow(/timed out after 20ms/);
    await flush();
    expect(calls[0].client.end).toHaveBeenCalled();
    expect(manager.getHistory('s')).toHaveLength(0);
    manager.closeAll();
  });

  it('rejects on connection error with the broker message', async () => {
    const { manager, calls } = harness();
    const sink = collector();
    const pending = manager.openSession({
      id: 's',
      url: 'mqtt://broker.test',
      onEvent: sink.onEvent,
    });
    calls[0].client.emit('error', new Error('connection refused'));
    await expect(pending).rejects.toThrow(/MQTT connection failed: connection refused/);
    expect(sink.events).toContainEqual(
      expect.objectContaining({ type: 'error', message: 'connection refused' })
    );
    manager.closeAll();
  });

  it('publishes text and base64, subscribes and unsubscribes with options', async () => {
    const h = harness();
    const sink = collector();
    const pending = h.manager.openSession({
      id: 's',
      url: 'mqtts://broker.test',
      onEvent: sink.onEvent,
    });
    const live = h.calls[0].client;
    live.connected = true;
    live.emit('connect', {});
    await pending;

    await h.manager.publish('s', {
      topic: 'sensors/temp',
      payload: '21.5',
      qos: 1,
      retain: true,
    });
    const [topic, payload, options] = live.publish.mock.calls[0];
    expect(topic).toBe('sensors/temp');
    expect(payload.toString('utf8')).toBe('21.5');
    expect(options).toEqual({ qos: 1, retain: true });

    const binary = Buffer.from([0x00, 0xff, 0x10]);
    await h.manager.publish('s', { topic: 'img', base64: binary.toString('base64'), qos: 2 });
    expect(live.publish.mock.calls[1][1]).toEqual(binary);
    expect(live.publish.mock.calls[1][2]).toEqual({ qos: 2, retain: false });

    await h.manager.subscribe('s', { topic: 'sensors/#', qos: 2 });
    expect(live.subscribe).toHaveBeenCalledWith('sensors/#', { qos: 2 }, expect.any(Function));

    await h.manager.unsubscribe('s', 'sensors/#');
    expect(live.unsubscribe).toHaveBeenCalledWith('sensors/#', expect.any(Function));

    h.manager.closeAll();
  });

  it('normalises text and binary messages with qos/retain metadata', async () => {
    const { manager, calls } = harness();
    const sink = collector();
    const pending = manager.openSession({
      id: 's',
      url: 'ws://broker.test/mqtt',
      onEvent: sink.onEvent,
    });
    const client = calls[0].client;
    client.connected = true;
    client.emit('connect', {});
    await pending;

    client.emit('message', 'sensors/temp', Buffer.from('hello'), { qos: 1, retain: true });
    const text = sink.events.find((e) => e.type === 'message');
    expect(text).toMatchObject({
      topic: 'sensors/temp',
      text: 'hello',
      size: 5,
      qos: 1,
      retain: true,
    });
    expect(text.payload).toBeUndefined();
    expect(typeof text.at).toBe('number');

    const binary = Buffer.from([0xff, 0xfe, 0x00]);
    client.emit('message', 'sensors/raw', binary, { qos: 0, retain: false });
    const bin = sink.events.filter((e) => e.type === 'message')[1];
    expect(bin.text).toBeUndefined();
    expect(Buffer.from(bin.payload, 'base64')).toEqual(binary);
    expect(bin).toMatchObject({ size: 3, qos: 0, retain: false });

    manager.closeAll();
  });

  it('rejects empty and unsupported URL schemes', async () => {
    const { manager } = harness();
    await expect(manager.openSession({ id: 's', url: '' })).rejects.toThrow(
      /MQTT URL is required/
    );
    await expect(
      manager.openSession({ id: 's', url: 'http://broker.test' })
    ).rejects.toThrow(/mqtt:\/\/, mqtts:\/\/, ws:\/\/ or wss:\/\//);
    await expect(manager.openSession({ id: 's', url: 'not a url' })).rejects.toThrow(
      /Invalid MQTT URL/
    );
  });

  it('caps history at 500 messages and counts drops', async () => {
    const { manager, calls } = harness();
    const sink = collector();
    const pending = manager.openSession({
      id: 's',
      url: 'mqtt://broker.test',
      onEvent: sink.onEvent,
    });
    const client = calls[0].client;
    client.connected = true;
    client.emit('connect', {});
    await pending;

    for (let i = 0; i < 505; i += 1) {
      client.emit('message', `t/${i}`, Buffer.from(`m${i}`), { qos: 0, retain: false });
    }

    const history = manager.getHistory('s');
    expect(history).toHaveLength(500);
    expect(history.dropped).toBe(5);
    expect(history[0].topic).toBe('t/5');
    expect(history[499].topic).toBe('t/504');
    manager.closeAll();
  });

  it('caps history at 1 MB and counts drops', async () => {
    const { manager, calls } = harness();
    const sink = collector();
    const pending = manager.openSession({
      id: 's',
      url: 'mqtt://broker.test',
      onEvent: sink.onEvent,
    });
    const client = calls[0].client;
    client.connected = true;
    client.emit('connect', {});
    await pending;

    const chunk = Buffer.alloc(300 * 1024, 0x61);
    for (let i = 0; i < 4; i += 1) {
      client.emit('message', `big/${i}`, chunk, { qos: 0, retain: false });
    }

    const history = manager.getHistory('s');
    expect(history).toHaveLength(3);
    expect(history.dropped).toBe(1);
    expect(history.bytes).toBeLessThanOrEqual(1024 * 1024);
    manager.closeAll();
  });

  it('closes a session, forgets its history, and ignores unknown ids', async () => {
    const { manager, calls } = harness();
    const sink = collector();
    const pending = manager.openSession({
      id: 's',
      url: 'mqtt://broker.test',
      onEvent: sink.onEvent,
    });
    const client = calls[0].client;
    client.connected = true;
    client.emit('connect', {});
    await pending;

    client.emit('message', 'a/b', Buffer.from('x'), { qos: 0, retain: false });
    expect(manager.getHistory('s')).toHaveLength(1);

    expect(await manager.closeSession('s')).toBe(true);
    expect(client.end).toHaveBeenCalled();
    expect(manager.getHistory('s')).toHaveLength(0);
    expect(await manager.closeSession('s')).toBe(false);

    expect(await manager.publish('missing', { topic: 'a', payload: 'b' })).toBe(false);
    expect(await manager.subscribe('missing', { topic: 'a' })).toBe(false);
    expect(await manager.unsubscribe('missing', 'a')).toBe(false);
    expect(manager.getHistory('missing')).toHaveLength(0);
  });
});
