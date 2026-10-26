import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'cli/relay.mjs');

function runCli(args, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out after ${timeoutMs}ms\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function postmanCollection(name, items) {
  return {
    info: {
      _postman_id: 'col_cli_test',
      name,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: items.map((item) => ({
      name: item.name,
      request: { method: 'GET', header: [], url: item.url },
      ...(item.event ? { event: item.event } : {}),
    })),
  };
}

function events({ preRequest, tests } = {}) {
  const list = [];
  if (preRequest) {
    list.push({
      listen: 'prerequest',
      script: { type: 'text/javascript', exec: preRequest.split('\n') },
    });
  }
  if (tests) {
    list.push({
      listen: 'test',
      script: { type: 'text/javascript', exec: tests.split('\n') },
    });
  }
  return list.length ? list : undefined;
}

describe('relay CLI', () => {
  let server;
  let port;
  let tmpDir;
  let seen;
  let seq = 0;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cli-'));
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      seen.push({ path: url.pathname, search: url.search, query: Object.fromEntries(url.searchParams) });
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  beforeEach(() => {
    seen = [];
  });

  afterAll(() => {
    server.closeAllConnections?.();
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeJson(data) {
    seq += 1;
    const file = path.join(tmpDir, `collection-${seq}.json`);
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return file;
  }

  function tempFile(name) {
    seq += 1;
    return path.join(tmpDir, `${seq}-${name}`);
  }

  it('runs a collection, writes a JUnit report, and exits 0', async () => {
    const collection = writeJson(
      postmanCollection('CLI Happy', [
        {
          name: 'One',
          url: `http://127.0.0.1:${port}/a`,
          event: events({ tests: "pm.test('ok', () => pm.response.to.have.status(200));" }),
        },
        {
          name: 'Two',
          url: `http://127.0.0.1:${port}/b`,
          event: events({ tests: "pm.test('ok too', () => pm.response.to.have.status(200));" }),
        },
      ])
    );
    const out = tempFile('run.xml');

    const result = await runCli(['run', collection, '--report', 'junit', '--out', out]);

    expect(result.code, result.stderr).toBe(0);
    expect(fs.existsSync(out)).toBe(true);
    const xml = fs.readFileSync(out, 'utf8');
    expect(xml).toContain('<testsuite');
    expect(xml.match(/<testcase/g)).toHaveLength(2);
    expect(xml).not.toContain('<failure');
    expect(seen.map((entry) => entry.path)).toEqual(['/a', '/b']);
    expect(result.stdout).toContain('Tests: 2 passed, 0 failed');
    expect(result.stdout).toContain(`Report: ${out}`);
  });

  it('exits 1 when an assertion fails and records a <failure>', async () => {
    const collection = writeJson(
      postmanCollection('CLI Failing', [
        {
          name: 'Expects 500',
          url: `http://127.0.0.1:${port}/a`,
          event: events({ tests: "pm.test('not ok', () => pm.response.to.have.status(500));" }),
        },
      ])
    );
    const out = tempFile('failed.xml');

    const result = await runCli(['run', collection, '--report', 'junit', '--out', out]);

    expect(result.code, result.stderr).toBe(1);
    const xml = fs.readFileSync(out, 'utf8');
    expect(xml).toContain('<failure');
    expect(result.stdout).toContain('Tests: 0 passed, 1 failed');
  });

  it('runs one iteration per --data CSV row', async () => {
    const collection = writeJson(
      postmanCollection('CLI Data', [
        {
          name: 'Echo',
          url: `http://127.0.0.1:${port}/echo?n={{n}}`,
          event: events({ tests: "pm.test('ok', () => pm.response.to.have.status(200));" }),
        },
      ])
    );
    seq += 1;
    const dataFile = path.join(tmpDir, `data-${seq}.csv`);
    fs.writeFileSync(dataFile, 'n,label\r\nalpha,first\r\nbeta,"second, quoted"\r\n');
    const out = tempFile('data.json');

    const result = await runCli([
      'run',
      collection,
      '--data',
      dataFile,
      '--report',
      'json',
      '--out',
      out,
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(seen.map((entry) => entry.query.n)).toEqual(['alpha', 'beta']);
    expect(result.stdout).toContain('Iterations: 2');
    const report = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(report.summary.iterations).toBe(2);
    expect(report.steps).toHaveLength(2);
  });

  it('exits 2 for a missing collection and for an unknown flag', async () => {
    const missing = await runCli(['run', path.join(tmpDir, 'does-not-exist.json')]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/Cannot read collection/);

    const unknown = await runCli(['run', 'whatever.json', '--nope']);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toMatch(/Unknown option/);
  });

  it('supports pm.sendRequest inside a pre-request script', async () => {
    const collection = writeJson(
      postmanCollection('CLI Scripts', [
        {
          name: 'With pre-request',
          url: `http://127.0.0.1:${port}/main`,
          event: events({
            preRequest: `pm.sendRequest('http://127.0.0.1:${port}/ping');`,
            tests: "pm.test('ok', () => pm.response.to.have.status(200));",
          }),
        },
      ])
    );
    const out = tempFile('scripts.json');

    const result = await runCli([
      'run',
      collection,
      '--report',
      'json',
      '--out',
      out,
      '--verbose',
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(seen.map((entry) => entry.path).sort()).toEqual(['/main', '/ping']);
    expect(result.stdout).toContain('GET');
  });
});
