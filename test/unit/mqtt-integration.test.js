import { Aedes } from 'aedes';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createMqttManager } from '../../electron/protocols/mqtt.js';

// Real-broker integration: proves the manager speaks MQTT over TCP (not just
// that it forwards calls to an injected client). This is the Fase 5
// acceptance criterion for MQTT.
let broker;
let server;
let manager;

async function startBroker() {
  broker = await Aedes.createBroker();
  server = net.createServer(broker.handle);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

function waitFor(predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

afterEach(async () => {
  manager?.closeAll();
  manager = null;
  await broker?.close?.();
  broker = null;
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
});

describe('MQTT against a real broker', () => {
  it('connects, subscribes, and receives text and binary payloads', async () => {
    const port = await startBroker();
    manager = createMqttManager();

    const events = [];
    await manager.openSession({
      id: 'sess-1',
      url: `mqtt://127.0.0.1:${port}`,
      clientId: 'relay-test-client',
      onEvent: (event) => events.push(event),
    });
    await waitFor(() => events.find((e) => e.type === 'connect'));

    expect(await manager.subscribe('sess-1', { topic: 'relay/#', qos: 0 })).toBe(true);
    expect(
      await manager.publish('sess-1', { topic: 'relay/echo', payload: 'hello', qos: 0 })
    ).toBe(true);

    const first = await waitFor(() => events.find((e) => e.type === 'message'));
    expect(first.topic).toBe('relay/echo');
    expect(first.text).toBe('hello');
    expect(first.size).toBe(5);

    const binaryBase64 = Buffer.from([0x00, 0xff, 0x01]).toString('base64');
    await manager.publish('sess-1', { topic: 'relay/bin', base64: binaryBase64, qos: 0 });

    const second = await waitFor(() =>
      events.filter((e) => e.type === 'message').find((e) => e.topic === 'relay/bin')
    );
    expect(second.payload).toBe(binaryBase64);
    expect(second.text).toBeUndefined();

    const history = manager.getHistory('sess-1');
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history.dropped).toBe(0);

    expect(await manager.closeSession('sess-1')).toBe(true);
  });

  it('rejects an unreachable broker with a clear error', async () => {
    manager = createMqttManager();
    await expect(
      manager.openSession({
        id: 'sess-bad',
        url: 'mqtt://127.0.0.1:1',
        onEvent: () => {},
      })
    ).rejects.toThrow(/MQTT connection failed/);
  });
});
