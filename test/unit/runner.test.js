import { describe, expect, it } from 'vitest';
import { runCollection } from '../../src/lib/runner.js';

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
