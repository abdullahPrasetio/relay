import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runCollection, RESPONSE_SNAPSHOT_LIMIT } from '../../src/lib/runner.js';

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
    const extra = mockState.pre ? await mockState.pre(request, context) : null;
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

describe('runner retries', () => {
  const okResponse = { ok: true, status: 200, headers: [], body: 'ok', timeMs: 2 };

  it('retries a 5xx response and records the successful attempt', async () => {
    const responses = [
      { ok: false, status: 500, error: 'Server error', headers: [], body: '', timeMs: 5 },
      okResponse,
    ];
    const ids = [];
    const send = async (_request, requestId) => {
      ids.push(requestId);
      return responses.shift();
    };

    const out = await runCollection({ requests, send, retries: 2 });

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(out.results[0].attempts).toBe(2);
    expect(out.results[0].retried).toBe(true);
    expect(out.results[0].ok).toBe(true);
    expect(out.summary.retriedRequests).toBe(1);
  });

  it('gives up after the configured number of extra attempts', async () => {
    let calls = 0;
    const send = async () => {
      calls += 1;
      return { ok: false, status: 503, error: 'Unavailable', headers: [], body: '', timeMs: 1 };
    };

    const out = await runCollection({ requests, send, retries: 1 });

    expect(calls).toBe(2);
    expect(out.results[0].attempts).toBe(2);
    expect(out.results[0].retried).toBe(true);
    expect(out.results[0].ok).toBe(false);
  });

  it('retries a transport error reported in the response object', async () => {
    const responses = [
      { ok: false, error: 'ECONNRESET', timeMs: 1 },
      okResponse,
    ];
    let calls = 0;
    const send = async () => {
      calls += 1;
      return responses.shift();
    };

    const out = await runCollection({ requests, send, retries: 1 });

    expect(calls).toBe(2);
    expect(out.results[0].ok).toBe(true);
    expect(out.results[0].attempts).toBe(2);
  });

  it('treats a thrown transport error as a failed attempt', async () => {
    let calls = 0;
    const send = async () => {
      calls += 1;
      if (calls === 1) throw new Error('socket hang up');
      return okResponse;
    };

    const out = await runCollection({ requests, send, retries: 1 });

    expect(calls).toBe(2);
    expect(out.results[0].attempts).toBe(2);
    expect(out.results[0].ok).toBe(true);
  });

  it('does not retry when retries is zero', async () => {
    let calls = 0;
    const send = async () => {
      calls += 1;
      return { ok: false, status: 500, error: 'boom', headers: [], body: '', timeMs: 1 };
    };

    const out = await runCollection({ requests, send });

    expect(calls).toBe(1);
    expect(out.results[0].attempts).toBe(1);
    expect(out.results[0].retried).toBe(false);
  });
});

describe('runner stop on error', () => {
  const two = [
    requests[0],
    { ...requests[0], id: 'req_2', name: 'Second', url: 'http://example.test/two' },
  ];

  it('stops the run after the first failed request', async () => {
    const calls = [];
    const send = async (request) => {
      calls.push(request.url);
      if (calls.length === 1) {
        return { ok: false, status: 500, error: 'boom', headers: [], body: '', timeMs: 1 };
      }
      return { ok: true, status: 200, headers: [], body: '', timeMs: 1 };
    };

    const out = await runCollection({ requests: two, send, stopOnError: true });

    expect(calls).toEqual(['http://example.test/one']);
    expect(out.results).toHaveLength(1);
    expect(out.summary.stoppedReason).toBe('error');
    expect(out.summary.aborted).toBe(false);
  });

  it('stops after a failed assertion', async () => {
    const calls = [];
    const send = async (request) => {
      calls.push(request.url);
      return { ok: true, status: 200, headers: [], body: '', timeMs: 1 };
    };
    mockState.test = async () => ({ results: [{ name: 'expects', passed: false, error: 'nope' }] });

    const out = await runCollection({ requests: two, send, stopOnError: true });

    expect(calls).toHaveLength(1);
    expect(out.summary.stoppedReason).toBe('error');
    expect(out.summary.testsFailed).toBe(1);
  });

  it('continues past failures when stopOnError is false', async () => {
    const calls = [];
    const send = async (request) => {
      calls.push(request.url);
      return { ok: false, status: 500, error: 'boom', headers: [], body: '', timeMs: 1 };
    };

    const out = await runCollection({ requests: two, send });

    expect(calls).toHaveLength(2);
    expect(out.summary.stoppedReason).toBeNull();
  });
});

describe('runner response snapshots', () => {
  const textual = (body) => ({
    ok: true,
    status: 200,
    headers: [{ key: 'Content-Type', value: 'text/plain; charset=utf-8' }],
    body,
    isBinary: false,
    timeMs: 1,
  });

  it('keeps a truncated textual body', async () => {
    const out = await runCollection({
      requests,
      send: async () => textual('x'.repeat(RESPONSE_SNAPSHOT_LIMIT + 5000)),
      saveResponses: true,
    });

    expect(out.results[0].response.status).toBe(200);
    expect(out.results[0].response.contentType).toBe('text/plain; charset=utf-8');
    expect(out.results[0].response.body).toHaveLength(RESPONSE_SNAPSHOT_LIMIT);
  });

  it('never stores binary payloads', async () => {
    const out = await runCollection({
      requests,
      send: async () => ({
        ok: true,
        status: 200,
        headers: [{ key: 'Content-Type', value: 'image/png' }],
        body: '',
        bodyBase64: 'iVBORw0KGgoAAAANSUhEUg==',
        isBinary: true,
        timeMs: 1,
      }),
      saveResponses: true,
    });

    const snapshot = out.results[0].response;
    expect(snapshot).toEqual({ status: 200, contentType: 'image/png', body: null });
    expect(JSON.stringify(snapshot)).not.toContain('iVBORw0KGgo');
  });

  it('omits snapshots by default', async () => {
    const out = await runCollection({
      requests,
      send: async () => textual('hello'),
    });

    expect(out.results[0].response).toBeUndefined();
  });
});

describe('runner variable persistence', () => {
  const mutate = async (_request, context) => {
    context.environment.token = 'changed';
    context.collection.mode = 'changed';
    return null;
  };

  it('keeps mutated scopes by default', async () => {
    mockState.pre = mutate;
    const out = await runCollection({
      requests,
      send: async () => ({ ok: true, status: 200, headers: [], body: '', timeMs: 1 }),
      environment: { token: 'original' },
      collection: { mode: 'original' },
    });

    expect(out.scopes.environment.token).toBe('changed');
    expect(out.scopes.collection.mode).toBe('changed');
  });

  it('restores the initial scopes when keepVariableValues is false', async () => {
    mockState.pre = mutate;
    const out = await runCollection({
      requests,
      send: async () => ({ ok: true, status: 200, headers: [], body: '', timeMs: 1 }),
      environment: { token: 'original' },
      collection: { mode: 'original' },
      keepVariableValues: false,
    });

    expect(out.scopes.environment.token).toBe('original');
    expect(out.scopes.collection.mode).toBe('original');
  });
});

describe('runner cancellation', () => {
  const two = [
    requests[0],
    { ...requests[0], id: 'req_2', name: 'Second', url: 'http://example.test/two' },
  ];

  it('stops before the next request when shouldStop flips', async () => {
    const calls = [];
    const send = async (request) => {
      calls.push(request.url);
      return { ok: true, status: 200, headers: [], body: '', timeMs: 1 };
    };

    const out = await runCollection({
      requests: two,
      send,
      shouldStop: () => calls.length >= 1,
    });

    expect(calls).toEqual(['http://example.test/one']);
    expect(out.summary.aborted).toBe(true);
    expect(out.summary.stoppedAtStep).toBe(1);
  });

  it('wins over the conditional-jump guard', async () => {
    const calls = [];
    const three = ['a', 'b', 'c'].map((path) => ({
      id: `req_${path}`,
      name: path,
      method: 'GET',
      url: `http://example.test/${path}`,
      params: [],
      headers: [],
      body: { mode: 'none' },
      auth: { type: 'none' },
    }));
    mockState.pre = async (request) => {
      if (request.id === 'req_a') return { nextRequestSet: true, nextRequest: 'b' };
      if (request.id === 'req_b') return { nextRequestSet: true, nextRequest: 'a' };
      return null;
    };
    const send = async (request) => {
      calls.push(request.url);
      return { ok: true, status: 200, headers: [], body: '', timeMs: 1 };
    };

    const out = await runCollection({
      requests: three,
      send,
      shouldStop: () => calls.length >= 2,
    });

    // Without shouldStop the A -> B -> A loop would execute three requests.
    expect(calls).toHaveLength(2);
    expect(out.summary.aborted).toBe(true);
    expect(out.summary.stoppedAtStep).toBe(2);
  });

  it('reports the request id to the caller before each send', async () => {
    const events = [];
    const sendIds = [];
    const send = async (_request, requestId) => {
      events.push('send');
      sendIds.push(requestId);
      return { ok: true, status: 200, headers: [], body: '', timeMs: 1 };
    };

    await runCollection({
      requests,
      send,
      onRequestId: (id) => {
        events.push('id');
        expect(id).toMatch(UUID_RE);
      },
    });

    expect(events).toEqual(['id', 'send']);
    expect(sendIds).toHaveLength(1);
  });
});
