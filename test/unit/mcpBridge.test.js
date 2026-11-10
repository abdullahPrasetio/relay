import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const BRIDGE = fileURLToPath(new URL('../../electron/mcp-stdio.cjs', import.meta.url));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createReader(stream) {
  const lines = [];
  const waiters = [];
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) {
        const waiter = waiters.shift();
        if (waiter) waiter(line);
        else lines.push(line);
      }
      index = buffer.indexOf('\n');
    }
  });
  return {
    next(timeoutMs = 4000) {
      if (lines.length) return Promise.resolve(lines.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('timed out waiting for a stdout line')),
          timeoutMs
        );
        waiters.push((line) => {
          clearTimeout(timer);
          resolve(line);
        });
      });
    },
    get count() {
      return lines.length;
    },
  };
}

// Fake Relay MCP endpoint: records requests and answers like the real server.
function createFakeEndpoint() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      requests.push({ headers: req.headers, body });

      if (req.headers.authorization !== 'Bearer good-token') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      if (!body || body.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Mcp-Session-Id': 'sess-1',
        'MCP-Protocol-Version': '2025-06-18',
      });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            serverInfo: { name: 'relay', version: '9.9.9' },
            echo: body.method,
          },
        })
      );
    });
  });
  return { server, requests };
}

async function startFake() {
  const fake = createFakeEndpoint();
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${fake.server.address().port}/mcp`;
  return { ...fake, url };
}

function startBridge(env) {
  const child = spawn(process.execPath, [BRIDGE], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = createReader(child.stdout);
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  return { child, stdout, stderr: () => stderr };
}

describe('stdio bridge', () => {
  let fake = null;
  let bridge = null;

  afterEach(async () => {
    if (bridge) {
      bridge.child.kill();
      bridge = null;
    }
    if (fake) {
      await new Promise((resolve) => fake.server.close(resolve));
      fake = null;
    }
  });

  it('exits with a message when the env vars are missing', async () => {
    const child = spawn(process.execPath, [BRIDGE], {
      env: { PATH: process.env.PATH },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    const code = await new Promise((resolve) => child.on('exit', resolve));
    expect(code).toBe(1);
    expect(stderr).toContain('RELAY_MCP_URL and RELAY_MCP_TOKEN are required');
  });

  it('proxies initialize and a tool call, keeping the session id', async () => {
    fake = await startFake();
    bridge = startBridge({ RELAY_MCP_URL: fake.url, RELAY_MCP_TOKEN: 'good-token' });

    bridge.child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't' } },
      })}\n`
    );
    const initLine = JSON.parse(await bridge.stdout.next());
    expect(initLine.result.serverInfo.name).toBe('relay');
    expect(fake.requests[0].headers.authorization).toBe('Bearer good-token');

    // A notification answers 202 and must not print anything.
    bridge.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`
    );
    while (fake.requests.length < 2) await delay(10);
    await delay(150);
    expect(bridge.stdout.count).toBe(0);

    bridge.child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'relay_app', arguments: { action: 'info' } },
      })}\n`
    );
    const callLine = JSON.parse(await bridge.stdout.next());
    expect(callLine.id).toBe(2);
    expect(callLine.result.echo).toBe('tools/call');

    const second = fake.requests[1];
    expect(second.headers['mcp-session-id']).toBe('sess-1');
    expect(second.headers['mcp-protocol-version']).toBe('2025-06-18');
  });

  it('turns a non-2xx response into a JSON-RPC error', async () => {
    fake = await startFake();
    bridge = startBridge({ RELAY_MCP_URL: fake.url, RELAY_MCP_TOKEN: 'bad-token' });

    bridge.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' })}\n`
    );
    const line = JSON.parse(await bridge.stdout.next());
    expect(line.id).toBe(7);
    expect(line.error.code).toBe(-32000);
    expect(line.error.message).toContain('401');
    // stderr is written after the response line; give the pipe a moment.
    for (let i = 0; i < 40 && !bridge.stderr().includes('401'); i += 1) await delay(10);
    expect(bridge.stderr()).toContain('401');
    // The token is never echoed.
    expect(bridge.stderr()).not.toContain('bad-token');
  });
});
