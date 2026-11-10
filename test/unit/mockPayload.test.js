import { describe, expect, it } from 'vitest';
import {
  MOCK_LIMITS,
  buildMockOverridePayload,
  buildMockPayload,
  buildScenarioPayload,
  mockPathFromUrl,
  normalizeMockHeaders,
  normalizeMockPath,
} from '../../src/lib/mockPayload.js';

describe('normalizeMockPath', () => {
  it('adds a leading slash and removes duplicate/trailing slashes', () => {
    expect(normalizeMockPath('orders//{id}/')).toBe('/orders/{id}');
    expect(normalizeMockPath('  /  ')).toBe('/');
  });

  it('drops query strings and fragments', () => {
    expect(normalizeMockPath('/orders?state=paid#top')).toBe('/orders');
  });
});

describe('mockPathFromUrl', () => {
  it('keeps only the path and turns templates into path params', () => {
    expect(mockPathFromUrl('https://api.example.com/orders/{{id}}?x=1')).toBe(
      '/orders/{id}'
    );
    expect(mockPathFromUrl('orders/42')).toBe('/orders/42');
    expect(mockPathFromUrl('')).toBe('/');
  });
});

describe('normalizeMockHeaders', () => {
  it('drops disabled and empty rows', () => {
    expect(
      normalizeMockHeaders([
        { key: 'X-Test', value: '1', enabled: true },
        { key: 'X-Off', value: '2', enabled: false },
        { key: '   ', value: 'ignored', enabled: true },
      ])
    ).toEqual({ 'X-Test': '1' });
  });

  it('rejects reserved, malformed, and multi-line headers', () => {
    expect(() => normalizeMockHeaders([{ key: 'Content-Length', value: '2' }])).toThrow(
      /set by the server/
    );
    expect(() => normalizeMockHeaders([{ key: 'Bad Header', value: 'x' }])).toThrow(
      /not valid/
    );
    expect(() => normalizeMockHeaders([{ key: 'X-Test', value: 'a\nb' }])).toThrow(
      /line break/
    );
  });
});

describe('buildMockPayload', () => {
  it('canonicalises a create payload', () => {
    expect(
      buildMockPayload({
        name: '  List orders  ',
        method: 'get',
        path: 'orders/{id}?ignored=1',
        statusCode: '201',
        responseHeaders: [{ key: 'X-Test', value: 'yes', enabled: true }],
        responseBody: '{"ok":true}',
        delayMs: '5',
        delayMaxMs: '10',
        errorRate: '25',
        errorStatusCode: '503',
        enabled: false,
      })
    ).toEqual({
      name: 'List orders',
      method: 'GET',
      path: '/orders/{id}',
      statusCode: 201,
      responseHeaders: { 'X-Test': 'yes' },
      responseBody: '{"ok":true}',
      delayMs: 5,
      delayMaxMs: 10,
      errorRate: 25,
      errorStatusCode: 503,
      enabled: false,
    });
  });

  it('leaves unsupplied defaults to the server', () => {
    expect(buildMockPayload({ method: 'POST', path: '/x' })).toEqual({
      method: 'POST',
      path: '/x',
    });
  });

  it('emits only supplied fields for a patch', () => {
    expect(
      buildMockPayload(
        { enabled: true, evaluationMode: 'manual', activeScenarioId: null },
        { partial: true }
      )
    ).toEqual({ enabled: true, evaluationMode: 'manual', activeScenarioId: null });
    expect(buildMockPayload({}, { partial: true })).toEqual({});
  });

  it('drops endpoint-only fields from generation overrides', () => {
    expect(
      buildMockOverridePayload({
        path: '/x',
        enabled: false,
        evaluationMode: 'manual',
        activeScenarioId: 'scenario',
      })
    ).toEqual({ path: '/x' });
  });

  it('rejects values outside the server limits', () => {
    expect(() => buildMockPayload({ method: 'TRACE', path: '/x' })).toThrow(/method/);
    expect(() => buildMockPayload({ method: 'GET', path: '/x', statusCode: 99 })).toThrow(
      /statusCode/
    );
    expect(() =>
      buildMockPayload({ method: 'GET', path: '/x', delayMs: MOCK_LIMITS.delayMs + 1 })
    ).toThrow(/delayMs/);
    expect(() =>
      buildMockPayload({ method: 'GET', path: '/x', delayMs: 100, delayMaxMs: 50 })
    ).toThrow(/delayMaxMs/);
    expect(() =>
      buildMockPayload({ method: 'GET', path: '/x', responseBody: 'x'.repeat(MOCK_LIMITS.bodyBytes + 1) })
    ).toThrow(/responseBody/);
    expect(() =>
      buildMockPayload({ method: 'GET', path: `/x/${'a'.repeat(MOCK_LIMITS.pathSegmentLength + 1)}` })
    ).toThrow(/path segment/);
  });
});

describe('buildScenarioPayload', () => {
  it('canonicalises text scenarios and conditions', () => {
    expect(
      buildScenarioPayload({
        name: '  paid  ',
        statusCode: '409',
        responseHeaders: { 'X-Test': '1' },
        responseBody: '{"paid":true}',
        conditions: [
          { source: 'QUERY', key: 'state', operator: 'EQUALS', value: 'paid' },
          { source: 'header', key: 'X-Tenant', operator: 'exists' },
        ],
        isDefault: true,
        orderIndex: '2',
      })
    ).toEqual({
      name: 'paid',
      statusCode: 409,
      responseHeaders: { 'X-Test': '1' },
      responseBody: '{"paid":true}',
      conditions: [
        { source: 'query', key: 'state', operator: 'equals', value: 'paid' },
        { source: 'header', key: 'X-Tenant', operator: 'exists', value: '' },
      ],
      isDefault: true,
      orderIndex: 2,
    });
  });

  it('validates file responses and clears file data for text', () => {
    const base64 = Buffer.from('invoice').toString('base64');
    expect(
      buildScenarioPayload({
        name: 'invoice',
        responseType: 'file',
        fileName: 'invoice.pdf',
        fileBase64: base64,
      })
    ).toMatchObject({
      responseType: 'file',
      fileName: 'invoice.pdf',
      fileBase64: base64,
    });
    expect(
      buildScenarioPayload({
        name: 'text',
        responseType: 'text',
        fileName: 'ignored.pdf',
        fileBase64: base64,
      })
    ).toMatchObject({ responseType: 'text', fileName: '', fileBase64: '' });

    expect(() =>
      buildScenarioPayload({
        name: 'bad',
        responseType: 'file',
        fileName: '../escape.pdf',
        fileBase64: base64,
      })
    ).toThrow(/plain file name/);
  });

  it('rejects bad conditions and oversized files', () => {
    expect(() =>
      buildScenarioPayload({ name: 'x', conditions: [{ source: 'cookie', key: 'a' }] })
    ).toThrow(/source/);
    expect(() =>
      buildScenarioPayload({
        name: 'x',
        conditions: [{ source: 'query', key: 'a', operator: 'regex', value: '(' }],
      })
    ).toThrow(/does not compile/);
    expect(() =>
      buildScenarioPayload({
        name: 'x',
        responseType: 'file',
        fileName: 'big.bin',
        fileBase64: 'a'.repeat(Math.ceil(((MOCK_LIMITS.fileBytes + 10) * 4) / 3)),
      })
    ).toThrow(/file exceeds/);
  });

  it('emits only supplied fields for a patch', () => {
    expect(buildScenarioPayload({ name: 'x' }, { partial: true })).toEqual({ name: 'x' });
  });
});
