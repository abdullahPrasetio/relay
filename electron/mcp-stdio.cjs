/**
 * Relay MCP stdio bridge.
 *
 * Lets an MCP client that only speaks stdio talk to the Relay desktop app's
 * local HTTP MCP endpoint. Newline-delimited JSON-RPC arrives on stdin; each
 * message is POSTed verbatim to the endpoint and the JSON-RPC response is
 * written back on stdout, one line per message.
 *
 * Environment:
 *   RELAY_MCP_URL    Full MCP endpoint, e.g. http://127.0.0.1:47821/mcp
 *   RELAY_MCP_TOKEN  Bearer token of an MCP client created in Relay
 *
 * stdout is protocol-only: never write logs or diagnostics there. Anything the
 * client should not parse goes to stderr. The token and URL are never printed.
 *
 * CommonJS on purpose: this file is copied verbatim into dist-electron and run
 * by the Electron binary with ELECTRON_RUN_AS_NODE=1 (or by plain Node 18+).
 */
'use strict';

const readline = require('node:readline');

const url = process.env.RELAY_MCP_URL;
const token = process.env.RELAY_MCP_TOKEN;

if (!url || !token) {
  process.stderr.write('relay-mcp-bridge: RELAY_MCP_URL and RELAY_MCP_TOKEN are required\n');
  process.exit(1);
}

if (typeof fetch !== 'function') {
  process.stderr.write('relay-mcp-bridge: global fetch is unavailable\n');
  process.exit(1);
}

let sessionId = null;
let protocolVersion = null;

const writeLine = (line) => {
  process.stdout.write(line + '\n');
};

const writeError = (id, code, message) => {
  writeLine(JSON.stringify({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } }));
};

const requestId = (line) => {
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === 'object' && 'id' in parsed) return parsed.id;
  } catch {
    // Not JSON: caller reports the parse error.
  }
  return null;
};

async function forward(line) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion;

  const res = await fetch(url, { method: 'POST', headers, body: line });

  const nextSession = res.headers.get('mcp-session-id');
  if (nextSession) sessionId = nextSession;
  const nextVersion = res.headers.get('mcp-protocol-version');
  if (nextVersion) protocolVersion = nextVersion;

  if (res.status === 202) return;

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    writeError(
      requestId(line),
      -32000,
      `Relay MCP HTTP ${res.status}`,
    );
    process.stderr.write(`relay-mcp-bridge: HTTP ${res.status} ${body.slice(0, 500)}\n`);
    return;
  }

  const contentType = res.headers.get('content-type') || '';

  if (contentType.includes('text/event-stream')) {
    const body = await res.text();
    for (const rawLine of body.split(/\r?\n/)) {
      if (!rawLine.startsWith('data:')) continue;
      const payload = rawLine.slice(5).trim();
      if (!payload) continue;
      try {
        JSON.parse(payload);
      } catch {
        continue;
      }
      writeLine(payload);
    }
    return;
  }

  const body = await res.text();
  if (!body) return;
  const trimmed = body.trim();
  try {
    JSON.parse(trimmed);
    writeLine(trimmed);
  } catch {
    writeError(requestId(line), -32700, 'Invalid JSON from server');
    process.stderr.write(`relay-mcp-bridge: invalid JSON response ${body.slice(0, 500)}\n`);
  }
}

// Requests are strictly sequential so session-id capture stays deterministic.
let chain = Promise.resolve();

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  if (!line.trim()) return;

  let id = null;
  try {
    JSON.parse(line);
  } catch {
    writeError(null, -32700, 'Parse error');
    return;
  }
  id = requestId(line);

  chain = chain.then(async () => {
    try {
      await forward(line);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      writeError(id, -32000, `Relay MCP bridge error: ${message}`);
      process.stderr.write(`relay-mcp-bridge: ${message}\n`);
    }
  });
});
