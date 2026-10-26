import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runCollection } from '../../src/lib/runner.js';

// The runner passes scripts to the main process; stub it so we can inspect the
// resolved variables without an IPC bridge.
const mockState = vi.hoisted(() => ({ localPatch: null, pre: null, test: null }));

const SCRIPT_DEFAULTS = {
  ran: true,
  requestPatch: {},
  logs: [],
  nextRequest: null,
  nextRequestSet: false,
  skip: false,
};

vi.mock('../../src/lib/testRunner.js', () => ({
  runPreRequest: async (_script, context, request) => {
    if (mockState.localPatch) Object.assign(context.local, mockState.localPatch);
    const extra = mockState.pre ? await mockState.pre(request) : null;
    return { ...SCRIPT_DEFAULTS, ...(extra || {}) };
  },
  runTests: async () => {
    const extra = mockState.test ? await mockState.test() : null;
    return { ...SCRIPT_DEFAULTS, results: [], ...(extra || {}) };
  },
}));

beforeEach(() => {
  mockState.localPatch = null;
  mockState.pre = null;
  mockState.test = null;
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const requests = [
  {
    id: 'req_1',
    name: 'First',
    method: 'GET',
    url: 'http://example.test/one',
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'none' },
  },
];

describe('runCollection transport contract', () => {
  it('passes a request id alongside each request', async () => {
    const calls = [];
    const send = async (request, requestId) => {
      calls.push({ request, requestId });
      return { ok: true, status: 200, statusText: 'OK', headers: [], body: 'ok', timeMs: 1 };
    };

    const out = await runCollection({ requests, send });

    expect(calls).toHaveLength(1);
    expect(calls[0].request.url).toBe('http://example.test/one');
    expect(calls[0].requestId).toMatch(UUID_RE);
    expect(out.summary.requestsOk).toBe(1);
  });

  it('uses a distinct id per request', async () => {
    const ids = [];
    const send = async (_request, requestId) => {
      ids.push(requestId);
      return { ok: true, status: 200, headers: [], body: '', timeMs: 1 };
    };

    await runCollection({
      requests: [
        requests[0],
        { ...requests[0], id: 'req_2', url: 'http://example.test/two' },
      ],
      send,
    });

    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => UUID_RE.test(id))).toBe(true);
  });
});

describe('runner variable precedence', () => {
  const scopedRequest = {
    ...requests[0],
    url: 'http://example.test/{{v}}?keep={{keep}}',
  };

  const capture = (calls) => async (request) => {
    calls.push(request);
    return { ok: true, status: 200, headers: [], body: '', timeMs: 1 };
  };

  it('lets a data row beat the environment', async () => {
    const calls = [];
    await runCollection({
      requests: [scopedRequest],
      send: capture(calls),
      environment: { v: 'env', keep: 'env-keep' },
      data: [{ v: 'data' }],
    });

    expect(calls[0].url).toBe('http://example.test/data?keep=env-keep');
  });

  it('lets local beat the data row', async () => {
    const calls = [];
    mockState.localPatch = { v: 'local' };
    await runCollection({
      requests: [scopedRequest],
      send: capture(calls),
      environment: { v: 'env' },
      data: [{ v: 'data' }],
    });

    expect(calls[0].url).toBe('http://example.test/local?keep={{keep}}');
  });

  it('uses a fresh local scope for each request', async () => {
    const seen = [];
    mockState.localPatch = { v: 'local' };
    const send = async (request) => {
      seen.push({ url: request.url });
      return { ok: true, status: 200, headers: [], body: '', timeMs: 1 };
    };

    // The mock assigns `local` on every call; two independent executions both
    // start from a clean object, so the second sees the same value, not a
    // merge of both requests' local writes.
    await runCollection({
      requests: [
        { ...scopedRequest, id: 'req_a' },
        { ...scopedRequest, id: 'req_b' },
      ],
      send,
      environment: { keep: 'env' },
    });

    expect(seen.map((s) => s.url)).toEqual([
      'http://example.test/local?keep=env',
      'http://example.test/local?keep=env',
    ]);
  });
});

describe('runner conditional flow (pm.execution)', () => {
  const step = (id, name, path) => ({
    id,
    name,
    method: 'GET',
    url: `http://example.test/${path}`,
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'none' },
  });

  const three = [
    step('req_a', 'First', 'a'),
    step('req_b', 'Second', 'b'),
    step('req_c', 'Third', 'c'),
  ];

  const collect = (calls) => async (request) => {
    calls.push(request.url);
    return { ok: true, status: 200, headers: [], body: '', timeMs: 1 };
  };

  it('stops the run when setNextRequest(null) is called', async () => {
    const calls = [];
    mockState.pre = async (request) =>
      request.id === 'req_a' ? { nextRequestSet: true, nextRequest: null } : null;

    const out = await runCollection({ requests: three, send: collect(calls) });

    expect(calls).toEqual(['http://example.test/a']);
    expect(out.results).toHaveLength(1);
  });

  it('jumps to the named request and skips the ones in between', async () => {
    const calls = [];
    mockState.pre = async (request) =>
      request.id === 'req_a' ? { nextRequestSet: true, nextRequest: 'Third' } : null;

    const out = await runCollection({ requests: three, send: collect(calls) });

    expect(calls).toEqual(['http://example.test/a', 'http://example.test/c']);
    expect(out.results.map((r) => r.name)).toEqual(['First', 'Third']);
    expect(out.summary.requestsOk).toBe(2);
  });

  it('jumps by request id as well as name', async () => {
    const calls = [];
    mockState.pre = async (request) =>
      request.id === 'req_a' ? { nextRequestSet: true, nextRequest: 'req_c' } : null;

    await runCollection({ requests: three, send: collect(calls) });
    expect(calls).toEqual(['http://example.test/a', 'http://example.test/c']);
  });

  it('stops on an unknown jump target instead of looping', async () => {
    const calls = [];
    mockState.pre = async (request) =>
      request.id === 'req_a' ? { nextRequestSet: true, nextRequest: 'Nope' } : null;

    const out = await runCollection({ requests: three, send: collect(calls) });

    expect(calls).toEqual(['http://example.test/a']);
    expect(out.results).toHaveLength(1);
  });

  it('allows each jump target once per iteration, then stops', async () => {
    const calls = [];
    mockState.pre = async (request) => {
      if (request.id === 'req_a') return { nextRequestSet: true, nextRequest: 'Second' };
      if (request.id === 'req_b') return { nextRequestSet: true, nextRequest: 'First' };
      return null;
    };

    const out = await runCollection({ requests: three, send: collect(calls) });

    // a -> b -> a; the second jump back to "Second" is refused, so the run ends.
    expect(calls).toEqual([
      'http://example.test/a',
      'http://example.test/b',
      'http://example.test/a',
    ]);
    expect(out.results).toHaveLength(3);
  });

  it('marks a skipped request without sending it or counting a failure', async () => {
    const calls = [];
    mockState.pre = async (request) =>
      request.id === 'req_b' ? { skip: true } : null;

    const out = await runCollection({ requests: three, send: collect(calls) });

    expect(calls).toEqual(['http://example.test/a', 'http://example.test/c']);
    expect(out.results.map((r) => r.skipped)).toEqual([false, true, false]);
    expect(out.results[1].ok).toBe(true);
    expect(out.results[1].status).toBeNull();
    expect(out.summary.requestsSkipped).toBe(1);
    expect(out.summary.requestsOk).toBe(2);
    expect(out.summary.requestsFailed).toBe(0);
  });

  it('lets a test script jump after seeing the response', async () => {
    const calls = [];
    mockState.test = async () => ({ nextRequestSet: true, nextRequest: 'Third' });

    // The first request jumps to "Third"; jumpCounts allows that target once,
    // so "Third" then ends the run when its test script asks again.
    const out = await runCollection({ requests: three, send: collect(calls) });

    expect(calls).toEqual(['http://example.test/a', 'http://example.test/c']);
    expect(out.results).toHaveLength(2);
  });

  it('marks a test-phase skipRequest as skipped', async () => {
    const calls = [];
    mockState.test = async () => ({ skip: true, results: [{ name: 'x', passed: false }] });

    const out = await runCollection({ requests: [three[0]], send: collect(calls) });

    expect(calls).toEqual(['http://example.test/a']);
    expect(out.results[0].skipped).toBe(true);
    expect(out.summary.requestsSkipped).toBe(1);
    expect(out.summary.testsFailed).toBe(0);
  });

  it('stops later iterations when setNextRequest(null) is used', async () => {
    const calls = [];
    mockState.pre = async () => ({ nextRequestSet: true, nextRequest: null });

    const out = await runCollection({ requests: [three[0]], send: collect(calls), iterations: 3 });

    expect(calls).toHaveLength(1);
    expect(out.results).toHaveLength(1);
  });
});
