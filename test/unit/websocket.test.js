import net from 'node:net';
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openSession,
  sendFrame,
  closeSession,
  getHistory,
  closeAll,
} from '../../electron/protocols/websocket.js';

const cleanups = [];

async function listen(wss) {
  if (wss.address()) return wss.address().port;
  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  return wss.address().port;
}

async function startServer(handler) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const port = await listen(wss);
  if (handler) wss.on('connection', handler);
  cleanups.push(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
  });
  return { wss, port, url: `ws://127.0.0.1:${port}` };
}

async function echoServer() {
  return startServer((socket) => {
    socket.on('message', (data, isBinary) => {
      socket.send(data, { binary: isBinary });
    });
  });
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
        reject(new Error('timed out waiting for WebSocket event'));
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

afterEach(async () => {
  closeAll();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe('websocket sessions', () => {
  it('connects and emits an open event', async () => {
    const server = await echoServer();
    const { onEvent, waitFor } = collector();

    await openSession({ id: 's-open', url: server.url, onEvent });

    const event = await waitFor((e) => e.type === 'open');
    expect(event.type).toBe('open');
    expect(typeof event.at).toBe('number');
  });

  it('echoes text and binary frames with the right type and size', async () => {
    const server = await echoServer();
    const { onEvent, waitFor } = collector();
    await openSession({ id: 's-echo', url: server.url, onEvent });

    await sendFrame('s-echo', { text: 'hello' });
    const text = await waitFor((e) => e.type === 'text');
    expect(text.data).toBe('hello');
    expect(text.size).toBe(5);
    expect(typeof text.at).toBe('number');

    const payload = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    await sendFrame('s-echo', { base64: payload.toString('base64') });
    const binary = await waitFor((e) => e.type === 'binary');
    expect(binary.size).toBe(4);
    expect(Buffer.from(binary.base64, 'base64')).toEqual(payload);
  });

  it('passes close codes and reasons through', async () => {
    const server = await startServer((socket) => {
      socket.on('message', () => socket.close(4001, 'going away'));
    });
    const { onEvent, waitFor } = collector();
    await openSession({ id: 's-close', url: server.url, onEvent });

    await sendFrame('s-close', { text: 'bye' });
    const closed = await waitFor((e) => e.type === 'close', 5000);
    expect(closed.code).toBe(4001);
    expect(closed.reason).toBe('going away');
  });

  it('rejects invalid and unreachable connections with a clear message', async () => {
    await expect(
      openSession({ id: 's-bad-url', url: 'http://example.com' })
    ).rejects.toThrow(/must start with ws/i);

    const port = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const p = probe.address().port;
        probe.close(() => resolve(p));
      });
    });

    await expect(
      openSession({ id: 's-refused', url: `ws://127.0.0.1:${port}` })
    ).rejects.toThrow(/WebSocket/);
  });

  it('errors when sending on a closed session', async () => {
    const server = await echoServer();
    await openSession({ id: 's-send-closed', url: server.url });
    await closeSession('s-send-closed');

    await expect(sendFrame('s-send-closed', { text: 'nope' })).rejects.toThrow(
      /not open/i
    );
    await expect(sendFrame('s-send-closed', { base64: 'AA==' })).rejects.toThrow(
      /not open/i
    );
  });

  it('caps history and counts dropped messages', async () => {
    const server = await echoServer();
    const { onEvent } = collector();
    await openSession({ id: 's-history', url: server.url, onEvent });

    for (let i = 0; i < 501; i += 1) {
      await sendFrame('s-history', { text: `m-${i}` });
    }

    const started = Date.now();
    let history;
    while (Date.now() - started < 10000) {
      history = getHistory('s-history');
      if (history.messages.length === 500 && history.dropped === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(history.messages).toHaveLength(500);
    expect(history.dropped).toBe(1);
    expect(history.messages[0].data).toBe('m-1');
    expect(history.messages.at(-1).data).toBe('m-500');
  });

  it('returns false when closing an unknown session', async () => {
    await expect(closeSession('does-not-exist')).resolves.toBe(false);
  });
});
