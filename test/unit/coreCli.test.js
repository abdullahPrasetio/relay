// Tests the Node worker entry point: packages/core/src/cli.js, bundled to
// dist-core/relay-core.mjs exactly as `npm run build:core` does.
//
// The CLI is a process boundary (stdin JSON -> stdout JSON), so each case
// spawns the real bundle against a local node:http server instead of mocking
// the engine.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build as esbuild } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const cliPath = path.join(root, 'dist-core/relay-core.mjs');

async function buildCli() {
  // Use the esbuild JS API instead of the platform binary: the wrapper resolves
  // the correct binary on every OS (the Windows binary is not at bin/esbuild).
  await esbuild({
    entryPoints: ['packages/core/src/cli.js'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: 'dist-core/relay-core.mjs',
    external: ['electron'],
    logLevel: 'silent',
    // The proxy-agent packages are CommonJS and lazily require Node builtins;
    // in an ESM bundle esbuild needs a real `require` for those calls.
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
    },
  });
}

function runCli(payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => {
      let json = null;
      try {
        json = stdout.trim() ? JSON.parse(stdout) : null;
      } catch {
        json = null;
      }
      resolve({ code, stdout, stderr, json });
    });
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

function requestNode(overrides = {}) {
  return {
    id: 'req_ok',
    type: 'request',
    name: 'Echo',
    method: 'GET',
    url: '',
    params: [],
    pathVars: [],
    headers: [],
    body: { mode: 'none', raw: '', form: [], graphql: { query: '', variables: '' } },
    auth: { type: 'inherit' },
    settings: {},
    examples: [],
    preRequest: '',
    tests: '',
    ...overrides,
  };
}

function workspaceWith(request, extra = {}) {
  return {
    id: 'ws_test',
    name: 'Test Workspace',
    activeEnvId: 'env_test',
    globals: [{ key: 'mode', value: 'test', enabled: true }],
    environments: [
      {
        id: 'env_test',
        name: 'Test',
        variables: [
          { key: 'baseUrl', value: baseUrl, enabled: true, type: 'default' },
          { key: 'who', value: 'world', enabled: true, type: 'default' },
          { key: 'ignored', value: 'disabled', enabled: false, type: 'default' },
        ],
      },
      {
        id: 'env_alt',
        name: 'Alt',
        variables: [
          { key: 'baseUrl', value: baseUrl, enabled: true, type: 'default' },
          { key: 'who', value: 'explicit-env', enabled: true, type: 'default' },
        ],
      },
    ],
    collections: [
      {
        id: 'col_test',
        name: 'Core',
        variables: [{ key: 'fromCollection', value: 'col-value', enabled: true }],
        auth: { type: 'none' },
        preRequest: '',
        tests: '',
        scriptsTrusted: true,
        items: [request],
      },
    ],
    ...extra,
  };
}

let server;
let baseUrl;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/echo') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        name: url.searchParams.get('name'),
        collection: url.searchParams.get('collection'),
        token: req.headers['x-token'] || null,
      })
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await buildCli();
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

describe('core CLI', () => {
  it('executes a stored request with variable substitution and inherited scripts', async () => {
    const workspace = workspaceWith(
      requestNode({
        url: '{{baseUrl}}/echo?name={{who}}&collection={{fromCollection}}',
        headers: [{ key: 'X-Token', value: '{{mode}}-token', enabled: true }],
        tests: [
          "pm.test('status is 200', () => pm.response.to.have.status(200));",
          "pm.test('env variable substituted', () => pm.expect(pm.response.json().name).to.eql('world'));",
          "pm.test('header substituted', () => pm.expect(pm.response.json().token).to.eql('test-token'));",
        ].join('\n'),
      })
    );

    const out = await runCli({ workspace, requestId: 'req_ok' });

    expect(out.code).toBe(0);
    expect(out.stderr).toBe('');
    expect(out.json).toBeTruthy();
    expect(out.json.error).toBeNull();
    expect(out.json.response.status).toBe(200);
    expect(Array.isArray(out.json.response.headers)).toBe(true);
    expect(out.json.response.headers.some((h) => h.key.toLowerCase() === 'content-type')).toBe(true);
    expect(typeof out.json.response.timeMs).toBe('number');
    expect(JSON.parse(out.json.response.body)).toMatchObject({
      name: 'world',
      collection: 'col-value',
      token: 'test-token',
    });
    expect(out.json.testResults).toHaveLength(3);
    expect(out.json.testResults.every((t) => t.passed === true)).toBe(true);
  });

  it('uses an explicit environmentId over the workspace active environment', async () => {
    const workspace = workspaceWith(
      requestNode({
        url: '{{baseUrl}}/echo?name={{who}}',
        tests: "pm.test('env wins', () => pm.expect(pm.response.json().name).to.eql('explicit-env'));",
      })
    );

    const out = await runCli({ workspace, requestId: 'req_ok', environmentId: 'env_alt' });

    expect(out.code).toBe(0);
    expect(JSON.parse(out.json.response.body).name).toBe('explicit-env');
    expect(out.json.testResults[0].passed).toBe(true);
  });

  it('applies pre-request script variable mutations before resolving the URL', async () => {
    const workspace = workspaceWith(
      requestNode({
        url: '{{baseUrl}}/echo?name={{who}}',
        preRequest: "pm.environment.set('who', 'from-pre-request');",
      })
    );

    const out = await runCli({ workspace, requestId: 'req_ok' });

    expect(out.code).toBe(0);
    expect(JSON.parse(out.json.response.body).name).toBe('from-pre-request');
  });

  it('reports a failing assertion without failing the process', async () => {
    const workspace = workspaceWith(
      requestNode({
        url: '{{baseUrl}}/echo?name={{who}}',
        tests: [
          "pm.test('passes', () => pm.response.to.have.status(200));",
          "pm.test('fails on purpose', () => pm.expect(1).to.eql(2));",
        ].join('\n'),
      })
    );

    const out = await runCli({ workspace, requestId: 'req_ok' });

    expect(out.code).toBe(0);
    expect(out.json.response.status).toBe(200);
    expect(out.json.error).toBeNull();
    expect(out.json.testResults).toHaveLength(2);
    const failed = out.json.testResults.find((t) => t.name === 'fails on purpose');
    expect(failed.passed).toBe(false);
    expect(failed.error).toBeTruthy();
  });

  it('exits non-zero on a transport error without printing env values to stderr', async () => {
    const workspace = workspaceWith(
      requestNode({
        // Port 1 is not listening; the engine returns a connection error.
        url: 'http://127.0.0.1:1/{{who}}',
      })
    );
    // Secret-looking value: stderr must stay static even when resolution uses it.
    workspace.environments[0].variables.push({
      key: 'secretToken',
      value: 'super-secret-value-123',
      enabled: true,
      type: 'secret',
    });
    workspace.collections[0].items[0].headers = [
      { key: 'Authorization', value: 'Bearer {{secretToken}}', enabled: true },
    ];

    const out = await runCli({ workspace, requestId: 'req_ok' });

    expect(out.code).toBe(1);
    expect(out.json.error).toBeTruthy();
    expect(out.json.response.status).toBeNull();
    expect(out.json.response.timeMs).toBeGreaterThanOrEqual(0);
    expect(out.json.testResults).toEqual([]);
    expect(out.stderr).not.toContain('super-secret-value-123');
  });

  it('exits 2 with static stderr when the request id is unknown', async () => {
    const workspace = workspaceWith(requestNode({ url: '{{baseUrl}}/echo' }));

    const out = await runCli({ workspace, requestId: 'req_missing' });

    expect(out.code).toBe(2);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('request or environment not found');
  });

  it('exits 2 on invalid stdin JSON', async () => {
    const out = await runCli('{not json');

    expect(out.code).toBe(2);
    expect(out.stderr).toContain('invalid JSON');
  });
});

// Keep the helper honest even if a future refactor stops emitting the bundle:
// the test fails loudly rather than silently skipping.
it('has a built bundle on disk', () => {
  expect(existsSync(cliPath)).toBe(true);
});
