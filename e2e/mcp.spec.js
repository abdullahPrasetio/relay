import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { closeApp, launchAppAt, makeUserData } from './helpers/app.js';

function seed() {
  return {
    schemaVersion: 3,
    workspaces: [
      {
        id: 'ws_mcp',
        name: 'MCP WS',
        collections: [
          {
            id: 'col_orders',
            name: 'Orders API',
            description: '',
            variables: [],
            auth: { type: 'none' },
            preRequest: '',
            tests: '',
            items: [
              {
                id: 'req_orders',
                type: 'request',
                name: 'Order',
                method: 'GET',
                url: 'https://api.example.com/orders',
                params: [],
                pathVars: [],
                headers: [],
                body: { mode: 'none', raw: '', form: [], graphql: { query: '', variables: '' } },
                auth: { type: 'none' },
                settings: {
                  timeoutMs: null,
                  followRedirects: null,
                  maxRedirects: null,
                  verifyTls: null,
                  proxyId: null,
                  useCookieJar: true,
                },
                grpc: {},
                preRequest: '',
                tests: '',
                examples: [],
              },
            ],
          },
        ],
        environments: [],
        globals: [],
        history: [],
        activeEnvId: null,
      },
    ],
    activeWorkspaceId: 'ws_mcp',
  };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// Minimal MCP Streamable HTTP client: JSON responses, session id reuse.
function createClient(url, token) {
  let sessionId = null;
  async function post(body) {
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }
  return {
    post,
    get sessionId() {
      return sessionId;
    },
    async initialize() {
      const init = await post({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'e2e', version: '1.0.0' },
        },
      });
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return init;
    },
    async call(name, action, params) {
      const res = await post({
        jsonrpc: '2.0',
        id: Math.floor(Math.random() * 100000) + 10,
        method: 'tools/call',
        params: { name, arguments: { action, ...(params ? { params } : {}) } },
      });
      const result = res.json?.result;
      return {
        status: res.status,
        isError: result?.isError === true,
        envelope: result?.content?.[0]?.text ? JSON.parse(result.content[0].text) : null,
      };
    },
  };
}

function storedCollections(page) {
  return page.evaluate(async () => {
    const data = await globalThis.api.loadData();
    const workspace = (data.workspaces || []).find((w) => w.id === 'ws_mcp');
    return (workspace?.collections || []).map((c) => c.name);
  });
}

test('MCP endpoint: scopes, approval, revocation and the stdio bridge', async () => {
  test.setTimeout(180000);
  const userData = makeUserData();
  fs.writeFileSync(
    path.join(userData, 'rest-tamer-data.json'),
    JSON.stringify(seed(), null, 2)
  );
  const session = await launchAppAt(userData);
  const { page } = session;

  try {
    const port = await freePort();
    const httpUrl = `http://127.0.0.1:${port}/mcp`;

    // ---- Server settings ----
    await page.locator('.ws-button').click();
    await page.getByTestId('ws-mcp').click();
    await page.getByTestId('mcp-port').fill(String(port));
    await page.getByRole('button', { name: 'Save port' }).click();
    await page.getByTestId('mcp-enabled').check();
    await expect(page.getByTestId('mcp-status')).toHaveText('running', { timeout: 15000 });
    await expect(page.getByTestId('mcp-http-url')).toHaveText(httpUrl);

    // ---- Clients ----
    async function createMcpClientInUi(name, scopes, approval) {
      await page.getByTestId('mcp-client-name').fill(name);
      for (const scope of scopes) {
        const box = page.getByTestId(`mcp-scope-${scope}`);
        if (!(await box.isChecked())) await box.check();
      }
      await page.getByTestId('mcp-client-approval').selectOption(approval);
      await page.getByTestId('mcp-create-client').click();
      const tokenInput = page.getByTestId('mcp-client-token');
      await expect(tokenInput).toBeVisible({ timeout: 10000 });
      const token = await tokenInput.inputValue();
      expect(token.startsWith('relay_mcp_')).toBe(true);
      return token;
    }

    const readToken = await createMcpClientInUi('read-only', [], 'always');
    const builderToken = await createMcpClientInUi('builder', ['write'], 'never');
    const approvalToken = await createMcpClientInUi('approval', ['write'], 'always');
    const runnerToken = await createMcpClientInUi('runner', ['request'], 'never');

    // Close the settings modal so the approval prompt is the only dialog.
    await page.locator('.modal-head button[title="Close"]').first().click();

    // ---- Read-only client ----
    const reader = createClient(httpUrl, readToken);
    const init = await reader.initialize();
    expect(init.json.result.serverInfo.name).toBe('relay');
    const tools = await reader.post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = tools.json.result.tools.map((tool) => tool.name);
    expect(names).toContain('relay_execute');

    const info = await reader.call('relay_app', 'info');
    expect(info.isError).toBe(false);
    expect(info.envelope.ok).toBe(true);

    const forbidden = await reader.call('relay_collections', 'create', { name: 'Nope' });
    expect(forbidden.isError).toBe(true);
    expect(forbidden.envelope.error.code).toBe('forbidden_scope');

    // ---- never-approval writer ----
    const builder = createClient(httpUrl, builderToken);
    await builder.initialize();
    const created = await builder.call('relay_collections', 'create', { name: 'AI Review' });
    expect(created.envelope.ok).toBe(true);
    await expect(page.locator('.collection-row', { hasText: 'AI Review' })).toHaveCount(1, {
      timeout: 10000,
    });
    await expect.poll(() => storedCollections(page)).toContain('AI Review');

    // ---- relay_execute.send through the real transport ----
    const target = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Mcp-Test': 'yes' });
      res.end('hello from mcp e2e');
    });
    await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
    try {
      const runner = createClient(httpUrl, runnerToken);
      await runner.initialize();
      const sent = await runner.call('relay_execute', 'send', {
        request: {
          method: 'GET',
          url: `http://127.0.0.1:${target.address().port}/ping`,
        },
      });
      expect(sent.isError).toBe(false);
      expect(sent.envelope.ok).toBe(true);
      const step = sent.envelope.data.result;
      expect(step.status).toBe(200);
      expect(step.response.body).toBe('hello from mcp e2e');
      expect(
        step.response.headers.some((header) => String(header.key).toLowerCase() === 'x-mcp-test')
      ).toBe(true);
    } finally {
      await new Promise((resolve) => target.close(resolve));
    }

    // ---- approval-policy writer: deny, then allow once ----
    const approvalClient = createClient(httpUrl, approvalToken);
    await approvalClient.initialize();

    const deniedPromise = approvalClient.call('relay_collections', 'create', {
      name: 'Denied Collection',
    });
    await expect(page.getByTestId('mcp-approval-summary')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('mcp-approval-deny').click();
    const denied = await deniedPromise;
    expect(denied.isError).toBe(true);
    expect(denied.envelope.error.code).toBe('denied');
    expect(await storedCollections(page)).not.toContain('Denied Collection');

    const allowedPromise = approvalClient.call('relay_collections', 'create', {
      name: 'Approved Collection',
    });
    await expect(page.getByTestId('mcp-approval-summary')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('mcp-approval-once').click();
    const allowed = await allowedPromise;
    expect(allowed.envelope.ok).toBe(true);
    await expect.poll(() => storedCollections(page)).toContain('Approved Collection');

    // ---- Revocation ----
    const config = await page.evaluate(() => globalThis.api.mcp.getConfig());
    const builderClient = config.clients.find((client) => client.name === 'builder');
    expect(builderClient).toBeTruthy();

    await page.locator('.ws-button').click();
    await page.getByTestId('ws-mcp').click();
    await page.getByTestId(`mcp-client-revoke-${builderClient.id}`).click();
    await page.getByTestId(`mcp-client-revoke-${builderClient.id}`).click();
    await expect
      .poll(async () => {
        const next = await page.evaluate(() => globalThis.api.mcp.getConfig());
        return next.clients.some((client) => client.id === builderClient.id);
      })
      .toBe(false);
    await page.locator('.modal-head button[title="Close"]').first().click();

    const revoked = await fetch(httpUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${builderToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'revoked', version: '1' },
        },
      }),
    });
    expect(revoked.status).toBe(401);

    // ---- stdio bridge ----
    const bridgePath = fileURLToPath(new URL('../dist-electron/mcp-stdio.cjs', import.meta.url));
    const child = spawn(process.execPath, [bridgePath], {
      env: { ...process.env, RELAY_MCP_URL: httpUrl, RELAY_MCP_TOKEN: readToken },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      const line = await new Promise((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(() => reject(new Error('bridge produced no output')), 15000);
        child.stdout.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          const index = buffer.indexOf('\n');
          if (index >= 0) {
            clearTimeout(timer);
            resolve(buffer.slice(0, index));
          }
        });
        child.stdin.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'bridge-e2e', version: '1' },
            },
          })}\n`
        );
      });
      const parsed = JSON.parse(line);
      expect(parsed.result.serverInfo.name).toBe('relay');
    } finally {
      child.kill();
    }
  } finally {
    await closeApp({ app: session.app, userData });
  }
});
