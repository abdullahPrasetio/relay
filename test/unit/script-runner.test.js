import { describe, expect, it, vi } from 'vitest';
import cryptoJs from 'crypto-js';
import { MAX_LOG_ENTRIES } from '../../packages/core/src/sandbox/index.js';
import { runScript } from '../../packages/core/src/script-runner.js';

const emptyContext = () => ({
  local: {},
  environment: {},
  collection: {},
  globals: {},
  iterationData: {},
});

describe('runScript scopes', () => {
  it('writes each pm scope to its own store', async () => {
    const input = emptyContext();
    input.local.gone = 'x';

    const out = await runScript({
      phase: 'pre',
      script: `
        pm.variables.set('localVar', 'L');
        pm.variables.unset('gone');
        pm.environment.set('envVar', 'E');
        pm.collectionVariables.set('colVar', 'C');
        pm.globals.set('globVar', 'G');
        pm.iterationData.set('dataVar', 'D');
        pm.variables.set('shared', 'local-wins');
        pm.environment.set('shared', 'environment');
      `,
      context: input,
    });

    expect(out.error).toBeNull();
    expect(out.context.local).toEqual({ localVar: 'L', shared: 'local-wins' });
    expect(out.context.environment).toEqual({ envVar: 'E', shared: 'environment' });
    expect(out.context.collection).toEqual({ colVar: 'C' });
    expect(out.context.globals).toEqual({ globVar: 'G' });
    expect(out.context.iterationData).toEqual({ dataVar: 'D' });
    // The caller's objects are copied, not mutated in place.
    expect(input.local).toEqual({ gone: 'x' });
    expect(input.environment).toEqual({});
  });

  it('reads through the scopes with local first', async () => {
    const out = await runScript({
      phase: 'pre',
      script: `
        pm.variables.set('seen', String(pm.variables.get('envOnly')));
        pm.variables.set('hasEnv', String(pm.variables.has('envOnly')));
        pm.variables.set('absent', String(pm.variables.has('nope')));
        pm.variables.set('snapshot', String(pm.variables.toObject().envOnly));
      `,
      context: { ...emptyContext(), environment: { envOnly: 'fromEnv' } },
    });

    expect(out.context.local).toEqual({
      seen: 'fromEnv',
      hasEnv: 'true',
      absent: 'false',
      snapshot: 'fromEnv',
    });
  });

  it('resolves replaceIn as local > environment > collection > globals > iteration data', async () => {
    const out = await runScript({
      phase: 'pre',
      script: `
        pm.variables.set('out', pm.variables.replaceIn('{{a}}|{{b}}|{{c}}|{{d}}|{{e}}|{{f}}|{{missing}}'));
        pm.variables.set('dollar', pm.variables.replaceIn('[{{pattern}}]'));
      `,
      context: {
        local: { a: 'local', b: 'localB', pattern: '$&' },
        environment: { a: 'env', b: 'envB', c: 'envC' },
        collection: { a: 'col', c: 'colC', d: 'colD' },
        globals: { a: 'glob', d: 'globD', e: 'globE' },
        iterationData: { f: 'dataF' },
      },
    });

    expect(out.context.local.out).toBe('local|localB|envC|colD|globE|dataF|{{missing}}');
    // `$&` in a value must stay literal, not become a replacement pattern.
    expect(out.context.local.dollar).toBe('[$&]');
  });

  it('keeps pm.iterationData readable and writable', async () => {
    const out = await runScript({
      phase: 'pre',
      script: `
        pm.iterationData.set('computed', pm.iterationData.get('base') + '-x');
        pm.variables.set('baseCopy', pm.iterationData.get('base'));
      `,
      context: { ...emptyContext(), iterationData: { base: 'row1' } },
    });

    expect(out.context.iterationData).toEqual({ base: 'row1', computed: 'row1-x' });
    expect(out.context.local.baseCopy).toBe('row1');
  });
});

describe('runScript trusted gate', () => {
  it('never executes untrusted scripts', async () => {
    for (const phase of ['pre', 'test']) {
      const out = await runScript({
        phase,
        script: 'pm.environment.set("leak", "1"); throw new Error("should not run")',
        trusted: false,
        context: emptyContext(),
      });
      expect(out).toEqual({
        ran: false,
        warning: 'Scripts from this collection are not trusted yet',
        results: [],
        logs: [],
      });
    }
  });
});

describe('runScript pm.test and request mutations', () => {
  const response = {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: 'hello world',
    headers: [{ key: 'Content-Type', value: 'text/plain' }],
    timeMs: 12,
  };
  const request = {
    method: 'GET',
    url: 'https://example.com/',
    headers: [{ key: 'Accept', value: '*/*' }],
    body: { mode: 'none' },
  };

  it('records pm.test results and pm.expect failures', async () => {
    const out = await runScript({
      phase: 'test',
      script: `
        pm.test('status is 200', () => { pm.expect(pm.response.code).to.equal(200); });
        pm.test('body mentions hello', () => { pm.expect(pm.response.text()).to.include('hello'); });
        pm.test('postman style status', () => { pm.response.to.have.status(200); });
        pm.test('never true', () => { pm.expect(1).to.equal(2); });
      `,
      response,
      request,
      context: emptyContext(),
    });

    expect(out.error).toBeNull();
    expect(out.results).toEqual([
      { name: 'status is 200', passed: true },
      { name: 'body mentions hello', passed: true },
      { name: 'postman style status', passed: true },
      { name: 'never true', passed: false, error: 'expected 1 to equal 2' },
    ]);
  });

  it('returns pm.request mutations as a patch', async () => {
    const out = await runScript({
      phase: 'pre',
      script: `
        pm.request.headers.add({ key: 'X-Debug', value: '1' });
        pm.request.headers.upsert({ key: 'Accept', value: 'application/json' });
        pm.request.url = 'https://changed.example/path';
        pm.request.method = 'POST';
      `,
      request,
      context: emptyContext(),
    });

    expect(out.error).toBeNull();
    expect(out.requestPatch).toEqual({
      headers: [
        { key: 'Accept', value: 'application/json', enabled: true },
        { key: 'X-Debug', value: '1', enabled: true },
      ],
      url: 'https://changed.example/path',
      method: 'POST',
    });
  });

  it('leaves requestPatch empty when the script mutates nothing', async () => {
    const out = await runScript({
      phase: 'pre',
      script: 'pm.variables.set("noop", "1");',
      request,
      context: emptyContext(),
    });
    expect(out.requestPatch).toEqual({});
  });
});

describe('runScript pm.sendRequest', () => {
  it('awaits the promise and callback paths', async () => {
    const send = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: '{"id":7}',
      headers: [],
      timeMs: 5,
    }));

    const out = await runScript({
      phase: 'pre',
      script: `
        pm.sendRequest('https://api.example.com/x', (err, res) => {
          pm.environment.set('fromCallback', String(res.json().id));
        });
        pm.sendRequest({ method: 'POST', url: 'https://api.example.com/y', body: { mode: 'raw', raw: 'hi' } })
          .then((res) => { pm.environment.set('fromPromise', String(res.code)); });
      `,
      context: emptyContext(),
      send,
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toEqual({
      method: 'GET',
      url: 'https://api.example.com/x',
      headers: [],
      params: [],
      body: { mode: 'none' },
    });
    expect(send.mock.calls[1][0]).toEqual({
      method: 'POST',
      url: 'https://api.example.com/y',
      headers: [],
      params: [],
      body: { mode: 'raw', raw: 'hi' },
    });
    expect(out.context.environment).toEqual({ fromCallback: '7', fromPromise: '200' });
  });

  it('fails with a clear timeout when the script budget is spent', async () => {
    const send = () => new Promise(() => {});
    const started = Date.now();
    const out = await runScript({
      phase: 'pre',
      script: `pm.sendRequest('https://slow.example.com/');`,
      send,
      timeoutMs: 150,
      context: emptyContext(),
    });
    expect(out.error).toBe('Script timed out after 150ms');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('reports a throw from inside the sendRequest callback', async () => {
    const send = vi.fn(async () => ({ ok: true, status: 200, body: '{}', headers: [], timeMs: 1 }));
    const out = await runScript({
      phase: 'pre',
      script: `
        pm.sendRequest('https://api.example.com/x', () => {
          throw new Error('callback boom');
        });
      `,
      context: emptyContext(),
      send,
    });
    expect(out.error).toBe('callback boom');
  });
});

describe('runScript console and errors', () => {
  it('captures console output with level and text', async () => {
    const out = await runScript({
      phase: 'pre',
      script: `
        console.log('hi', 42);
        console.warn('careful');
        console.error('bad');
      `,
      context: emptyContext(),
    });
    expect(out.logs).toEqual([
      { level: 'log', text: 'hi 42' },
      { level: 'warn', text: 'careful' },
      { level: 'error', text: 'bad' },
    ]);
  });

  it('caps captured console output', async () => {
    const out = await runScript({
      phase: 'pre',
      script: 'for (let i = 0; i < 1500; i++) console.log("n" + i);',
      context: emptyContext(),
    });
    expect(out.logs.length).toBe(MAX_LOG_ENTRIES);
    expect(out.logs.at(-1).text).toMatch(/truncated/i);
  });

  it('returns a thrown error without crashing the process', async () => {
    const pre = await runScript({
      phase: 'pre',
      script: 'throw new Error("boom")',
      context: emptyContext(),
    });
    expect(pre.ran).toBe(true);
    expect(pre.error).toBe('boom');

    const test = await runScript({
      phase: 'test',
      script: 'throw new Error("boom")',
      context: emptyContext(),
    });
    expect(test.error).toBe('boom');
    expect(test.results).toEqual([{ name: 'Script error', passed: false, error: 'boom' }]);
  });

  it('times out a synchronous infinite loop', async () => {
    const started = Date.now();
    const out = await runScript({
      phase: 'pre',
      script: 'while (true) {}',
      context: emptyContext(),
      timeoutMs: 120,
    });
    expect(out.error).toMatch(/timed out/i);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('exposes only the allow-listed modules', async () => {
    const out = await runScript({
      phase: 'pre',
      script: `
        const { v4 } = require('uuid');
        pm.environment.set('id', v4());
        pm.environment.set('md5', require('crypto-js').MD5('relay').toString());
      `,
      context: emptyContext(),
    });
    expect(out.error).toBeNull();
    expect(out.context.environment.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(out.context.environment.md5).toBe(cryptoJs.MD5('relay').toString());

    const blocked = await runScript({
      phase: 'pre',
      script: `require('fs')`,
      context: emptyContext(),
    });
    expect(blocked.error).toBe("require('fs') is not available in scripts");
  });

  it('does not run when the script is blank', async () => {
    const out = await runScript({ phase: 'pre', script: '   ', context: emptyContext() });
    expect(out.ran).toBe(false);
    expect(out.context).toHaveProperty('local');
    expect(out.context).toHaveProperty('iterationData');
  });
});

describe('runScript execution directives', () => {
  it('returns setNextRequest and skipRequest from pm.execution', async () => {
    const out = await runScript({
      phase: 'pre',
      script: `
        pm.execution.setNextRequest('req_next');
        pm.execution.skipRequest();
      `,
      context: emptyContext(),
    });

    expect(out.error).toBeNull();
    expect(out.nextRequestSet).toBe(true);
    expect(out.nextRequest).toBe('req_next');
    expect(out.skip).toBe(true);
  });

  it('defaults the execution outcome when the script does not use it', async () => {
    const out = await runScript({
      phase: 'pre',
      script: 'pm.variables.set("x", "1");',
      context: emptyContext(),
    });

    expect(out.nextRequestSet).toBe(false);
    expect(out.nextRequest).toBeNull();
    expect(out.skip).toBe(false);
    expect(out.visualizer).toBeNull();
  });

  it('returns the pm.visualizer payload', async () => {
    const out = await runScript({
      phase: 'test',
      script: `pm.visualizer.set('<b>{{v}}</b>', { v: 1 });`,
      response: { ok: true, status: 200, headers: [], body: '', timeMs: 1 },
      context: emptyContext(),
    });

    expect(out.visualizer).toEqual({ template: '<b>{{v}}</b>', data: { v: 1 } });
  });

  it('exposes pm.cookies from the response and the optional jar', async () => {
    const out = await runScript({
      phase: 'test',
      script: `
        pm.environment.set('session', String(pm.cookies.get('session')));
        pm.environment.set('jarred', String(pm.cookies.get('jarred')));
      `,
      response: {
        ok: true,
        status: 200,
        headers: [],
        body: '',
        timeMs: 1,
        cookies: [{ name: 'session', value: 'abc' }],
      },
      jar: [{ name: 'jarred', value: 'xyz' }],
      context: emptyContext(),
    });

    expect(out.error).toBeNull();
    expect(out.context.environment).toEqual({ session: 'abc', jarred: 'xyz' });
  });
});
