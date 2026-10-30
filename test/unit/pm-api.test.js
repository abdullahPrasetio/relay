import { describe, expect, it } from 'vitest';
import { runScript } from '../../packages/core/src/script-runner.js';

const emptyContext = () => ({
  local: {},
  environment: {},
  collection: {},
  globals: {},
  iterationData: {},
});

const okResponse = {
  ok: true,
  status: 200,
  statusText: 'OK',
  body: JSON.stringify({ id: 7, tags: ['a', 'b'] }),
  headers: [
    { key: 'Content-Type', value: 'application/json; charset=utf-8' },
    { key: 'X-Trace', value: 'abc' },
  ],
  timeMs: 42,
  size: 25,
  cookies: [{ name: 'session', value: 's1' }],
};

const baseRequest = {
  method: 'GET',
  url: 'https://api.example.com/users/:id',
  params: [
    { key: 'page', value: '1', enabled: true },
    { key: 'off', value: 'x', enabled: false },
  ],
  pathVars: [{ key: 'id', value: '42' }],
  headers: [{ key: 'Accept', value: '*/*', enabled: true }],
  body: { mode: 'none', raw: '', form: [] },
};

async function runTest(script, overrides = {}) {
  return runScript({
    phase: 'test',
    script,
    response: okResponse,
    request: baseRequest,
    context: emptyContext(),
    ...overrides,
  });
}

async function runPre(script, overrides = {}) {
  return runScript({
    phase: 'pre',
    script,
    request: baseRequest,
    context: emptyContext(),
    ...overrides,
  });
}

const allPassed = (out) => {
  expect(out.error).toBeNull();
  return out.results.map((r) => ({ name: r.name, passed: r.passed }));
};

describe('pm.response', () => {
  it('exposes code/status/time/text/json/size and the header list', async () => {
    const out = await runTest(`
      pm.test('code', () => { pm.expect(pm.response.code).to.equal(200); });
      pm.test('status text', () => { pm.expect(pm.response.status).to.equal('OK'); });
      pm.test('response time', () => { pm.expect(pm.response.responseTime).to.equal(42); });
      pm.test('json', () => { pm.expect(pm.response.json().id).to.equal(7); });
      pm.test('text', () => { pm.expect(pm.response.text()).to.include('"id":7'); });
      pm.test('size', () => { pm.expect(pm.response.size()).to.equal(25); });
      pm.test('header get', () => { pm.expect(pm.response.headers.get('content-type')).to.include('json'); });
      pm.test('header has', () => { pm.expect(pm.response.headers.has('X-TRACE')).to.be.true; });
      pm.test('header one', () => { pm.expect(pm.response.headers.one('X-Trace').value).to.equal('abc'); });
      pm.test('header toObject', () => {
        pm.expect(pm.response.headers.toObject()).to.have.property('X-Trace', 'abc');
      });
    `);

    expect(allPassed(out).every((r) => r.passed)).toBe(true);
    expect(out.results).toHaveLength(10);
  });

  it('accepts number, code string, status text and regex for to.have.status', async () => {
    const out = await runTest(`
      pm.test('number', () => pm.response.to.have.status(200));
      pm.test('code string', () => pm.response.to.have.status('200'));
      pm.test('status text', () => pm.response.to.have.status('OK'));
      pm.test('regex', () => pm.response.to.have.status(/^2\\d\\d$/));
      pm.test('header exists', () => pm.response.to.have.header('Content-Type'));
      pm.test('header value', () => pm.response.to.have.header('X-Trace', 'abc'));
      pm.test('jsonBody', () => pm.response.to.have.jsonBody());
      pm.test('body regex', () => pm.response.to.have.body(/"id":7/));
      pm.test('be ok', () => pm.response.to.be.ok);
      pm.test('not 404', () => pm.response.to.not.have.status(404));
      pm.test('not missing header', () => pm.response.to.not.have.header('X-Missing'));
      pm.test('not matching status', () => pm.response.to.not.have.status(/^5/));
    `);

    expect(out.results.every((r) => r.passed)).toBe(true);
    expect(out.results).toHaveLength(12);
  });

  it('turns a failed request into assertion failures, not crashes', async () => {
    const out = await runScript({
      phase: 'test',
      script: `
        pm.test('status', () => { pm.response.to.have.status(200); });
        pm.test('json', () => { pm.response.json(); });
        pm.test('not status', () => { pm.response.to.not.have.status(200); });
        pm.test('code is 0', () => { pm.expect(pm.response.code).to.equal(0); });
      `,
      response: { ok: false, error: 'ECONNREFUSED', timeMs: 3 },
      request: baseRequest,
      context: emptyContext(),
    });

    expect(out.error).toBeNull();
    expect(out.results.map((r) => r.passed)).toEqual([false, false, true, true]);
    expect(out.results[0].error).toContain('ECONNREFUSED');
    expect(out.results[0].error).toContain('request failed');
    expect(out.results[1].error).toContain('cannot read response JSON');
  });
});

describe('pm.request mutations', () => {
  it('records method and url (string form)', async () => {
    const out = await runPre(`
      pm.request.method = 'patch';
      pm.request.url = 'https://changed.example/path';
      pm.variables.set('readUrl', String(pm.request.url));
    `);
    expect(out.error).toBeNull();
    expect(out.requestPatch).toEqual({
      method: 'PATCH',
      url: 'https://changed.example/path',
    });
    expect(out.context.local.readUrl).toBe('https://changed.example/path');
  });

  it('records url (object form) plus its query and variables', async () => {
    const out = await runPre(`
      pm.request.url = {
        protocol: 'https',
        host: ['api', 'example', 'com'],
        path: ['v2', 'users'],
        query: [{ key: 'page', value: '2' }],
        variable: [{ key: 'id', value: '99' }],
      };
    `);
    expect(out.error).toBeNull();
    expect(out.requestPatch.url).toBe('https://api.example.com/v2/users');
    expect(out.requestPatch.params).toEqual([
      { key: 'page', value: '2', enabled: true },
      { key: 'off', value: 'x', enabled: false },
    ]);
    expect(out.requestPatch.pathVars).toEqual([{ key: 'id', value: '99' }]);
  });

  it('supports headers add/upsert/remove/get', async () => {
    const out = await runPre(`
      pm.variables.set('before', String(pm.request.headers.get('accept')));
      pm.request.headers.add({ key: 'X-Debug', value: '1' });
      pm.request.headers.upsert({ key: 'Accept', value: 'application/json' });
      pm.request.headers.remove('X-Gone');
    `);
    expect(out.error).toBeNull();
    expect(out.context.local.before).toBe('*/*');
    expect(out.requestPatch.headers).toEqual([
      { key: 'Accept', value: 'application/json', enabled: true },
      { key: 'X-Debug', value: '1', enabled: true },
    ]);
  });

  it('supports query add/upsert/remove as merged deltas', async () => {
    const out = await runPre(`
      pm.request.query.add({ key: 'sort', value: 'desc' });
      pm.request.url.query.upsert({ key: 'page', value: '3' });
      pm.request.query.remove('off');
      pm.variables.set('page', String(pm.request.query.get('page')));
    `);
    expect(out.error).toBeNull();
    expect(out.context.local.page).toBe('3');
    expect(out.requestPatch.params).toEqual([
      { key: 'page', value: '3', enabled: true },
      { key: 'sort', value: 'desc', enabled: true },
    ]);
    expect(out.requestPatch.removedParams).toEqual(['off']);
  });

  it('supports body update(raw), mode and urlencoded/formdata adds', async () => {
    const raw = await runPre(`pm.request.body.update('{"a":1}');`);
    expect(raw.requestPatch.body).toEqual({ mode: 'raw', raw: '{"a":1}', form: [] });

    const mode = await runPre(`pm.request.body.update({ mode: 'json' });`);
    expect(mode.requestPatch.body.mode).toBe('json');

    const urlencoded = await runPre(`
      pm.request.body.urlencoded.add({ key: 'k', value: 'v' });
    `);
    expect(urlencoded.requestPatch.body.mode).toBe('form-urlencoded');
    expect(urlencoded.requestPatch.body.form).toEqual([{ key: 'k', value: 'v', enabled: true }]);

    const formdata = await runPre(`
      pm.request.body.formdata.add({ key: 'file', value: '/tmp/a.txt', type: 'file' });
    `);
    expect(formdata.requestPatch.body.mode).toBe('form-data');
    expect(formdata.requestPatch.body.form).toEqual([
      { key: 'file', value: '/tmp/a.txt', enabled: true, type: 'file' },
    ]);
  });

  it('supports pathVars add/upsert/remove', async () => {
    const out = await runPre(`
      pm.request.pathVars.upsert({ key: 'id', value: '7' });
      pm.request.pathVars.add({ key: 'slug', value: 'hello' });
      pm.request.pathVars.remove('gone');
      pm.variables.set('id', String(pm.request.pathVars.get('id')));
    `);
    expect(out.error).toBeNull();
    expect(out.context.local.id).toBe('7');
    expect(out.requestPatch.pathVars).toEqual([
      { key: 'id', value: '7' },
      { key: 'slug', value: 'hello' },
    ]);
    expect(out.requestPatch.removedPathVars).toEqual(['gone']);
  });
});

describe('pm.expect chains', () => {
  it('supports the full chai-style surface', async () => {
    const out = await runTest(`
      pm.test('equal', () => pm.expect(1).to.equal(1));
      pm.test('deep equal', () => pm.expect({ a: [1, 2] }).to.deep.equal({ a: [1, 2] }));
      pm.test('eql', () => pm.expect([1, { b: 2 }]).to.eql([1, { b: 2 }]));
      pm.test('include string', () => pm.expect('relay').to.include('lay'));
      pm.test('include array of objects', () => pm.expect([{ a: 1, b: 2 }]).to.include({ a: 1 }));
      pm.test('members', () => pm.expect([1, 2, 3]).to.have.members([3, 1, 2]));
      pm.test('deep members', () => pm.expect([{ a: 1 }]).to.deep.include({ a: 1 }));
      pm.test('lengthOf', () => pm.expect('abc').to.have.lengthOf(3));
      pm.test('property', () => pm.expect({ id: 7 }).to.have.property('id', 7));
      pm.test('match', () => pm.expect('abc').to.match(/^a.c$/));
      pm.test('throw', () => pm.expect(() => { throw new Error('kaboom'); }).to.throw('kaboom'));
      pm.test('instanceof', () => pm.expect([]).to.be.an.instanceof(Array));
      pm.test('instanceof Date', () => pm.expect(new Date()).to.be.an.instanceof(Date));
      pm.test('empty array', () => pm.expect([]).to.be.empty);
      pm.test('empty object', () => pm.expect({}).to.be.empty);
      pm.test('above', () => pm.expect(5).to.be.above(4));
      pm.test('below', () => pm.expect(4).to.be.below(5));
      pm.test('least', () => pm.expect(5).to.be.at.least(5));
      pm.test('most', () => pm.expect(5).to.be.at.most(5));
      pm.test('within', () => pm.expect(5).to.be.within(1, 10));
      pm.test('oneOf', () => pm.expect(2).to.be.oneOf([1, 2, 3]));
      pm.test('satisfy', () => pm.expect(6).to.satisfy((n) => n % 2 === 0));
      pm.test('a string', () => pm.expect('x').to.be.a('string'));
      pm.test('an object', () => pm.expect({}).to.be.an('object'));
      pm.test('ok', () => pm.expect(1).to.be.ok);
      pm.test('true', () => pm.expect(true).to.be.true);
      pm.test('false', () => pm.expect(false).to.be.false);
      pm.test('null', () => pm.expect(null).to.be.null);
      pm.test('undefined', () => pm.expect(undefined).to.be.undefined);
      pm.test('exist', () => pm.expect(0).to.exist);
      pm.test('NaN', () => pm.expect(NaN).to.be.NaN);
      pm.test('json', () => pm.expect('{"a":1}').to.be.json);
      pm.test('not equal', () => pm.expect(1).to.not.equal(2));
      pm.test('not include', () => pm.expect('relay').to.not.include('zzz'));
      pm.test('not property', () => pm.expect({}).to.not.have.property('id'));
      pm.test('not throw', () => pm.expect(() => 1).to.not.throw());
    `);

    expect(out.error).toBeNull();
    const failed = out.results.filter((r) => !r.passed);
    expect(failed).toEqual([]);
    expect(out.results).toHaveLength(36);
  });

  it('reports expected vs actual and supports expect.fail', async () => {
    const out = await runTest(`
      pm.test('mismatch', () => pm.expect(2).to.equal(1));
      pm.test('deep mismatch', () => pm.expect({ a: 1 }).to.deep.equal({ a: 2 }));
      pm.test('negated mismatch', () => pm.expect('relay').to.not.include('lay'));
      pm.test('fail', () => pm.expect.fail('explicit failure'));
    `);

    expect(out.results[0]).toEqual({
      name: 'mismatch',
      passed: false,
      error: 'expected 2 to equal 1',
    });
    expect(out.results[1].error).toBe('expected {"a":1} to deeply equal {"a":2}');
    expect(out.results[2].error).toBe('expected "relay" not to include "lay"');
    expect(out.results[3].error).toBe('explicit failure');
  });

  it('keeps failing assertions inside pm.test instead of aborting the script', async () => {
    const out = await runTest(`
      pm.test('first fails', () => pm.expect(1).to.equal(2));
      pm.test('second still runs', () => pm.expect(1).to.equal(1));
    `);
    expect(out.error).toBeNull();
    expect(out.results.map((r) => r.passed)).toEqual([false, true]);
  });
});

describe('pm.cookies', () => {
  it('reads response cookies and the persisted jar, response wins', async () => {
    const out = await runTest(
      `
      pm.test('cookies', () => {
        pm.expect(pm.cookies.get('session')).to.equal('s1');
        pm.expect(pm.cookies.get('stored')).to.equal('jar-val');
        pm.expect(pm.cookies.has('missing')).to.be.false;
        pm.expect(pm.cookies.toObject()).to.deep.equal({ session: 's1', stored: 'jar-val' });
      });
    `,
      { jar: [{ name: 'stored', value: 'jar-val' }] }
    );

    expect(out.results[0].passed).toBe(true);
  });
});

describe('pm.visualizer', () => {
  it('records the template and data for the renderer', async () => {
    const out = await runTest(`
      pm.visualizer.set('<p>{{name}}</p>', { name: 'relay' });
    `);
    expect(out.error).toBeNull();
    expect(out.visualizer).toEqual({ template: '<p>{{name}}</p>', data: { name: 'relay' } });
  });

  it('is null when the script never sets it', async () => {
    const out = await runTest(`pm.test('noop', () => pm.expect(true).to.be.true);`);
    expect(out.visualizer).toBeNull();
  });
});

describe('pm.execution', () => {
  it('records setNextRequest with a name and with null', async () => {
    const named = await runPre(`pm.execution.setNextRequest('Second');`);
    expect(named.nextRequestSet).toBe(true);
    expect(named.nextRequest).toBe('Second');

    const stop = await runPre(`pm.execution.setNextRequest(null);`);
    expect(stop.nextRequestSet).toBe(true);
    expect(stop.nextRequest).toBeNull();

    const none = await runPre(`pm.variables.set('x', '1');`);
    expect(none.nextRequestSet).toBe(false);
    expect(none.nextRequest).toBeNull();
  });

  it('records skipRequest', async () => {
    const out = await runPre(`pm.execution.skipRequest();`);
    expect(out.skip).toBe(true);
  });
});

describe('legacy postman.* aliases', () => {
  it('writes the requested scopes and forwards setNextRequest', async () => {
    const out = await runPre(`
      postman.setEnvironmentVariable('envVar', 'E');
      postman.setGlobalVariable('globalVar', 'G');
      pm.variables.set('envRead', String(postman.getEnvironmentVariable('envVar')));
      pm.variables.set('globalRead', String(postman.getGlobalVariable('globalVar')));
      postman.clearEnvironmentVariable('envVar');
      postman.setNextRequest('Third');
    `);

    expect(out.error).toBeNull();
    expect(out.context.environment).toEqual({});
    expect(out.context.globals).toEqual({ globalVar: 'G' });
    expect(out.context.local).toEqual({ envRead: 'E', globalRead: 'G' });
    expect(out.nextRequestSet).toBe(true);
    expect(out.nextRequest).toBe('Third');
  });
});
