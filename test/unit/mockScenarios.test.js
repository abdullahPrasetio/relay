import { describe, expect, it } from 'vitest';
import {
  compileRoute,
  configNeedsBody,
  evaluateCondition,
  matchRoutes,
  normalizeMockConfig,
  normalizePath,
  pathnameOf,
  renderMockTemplate,
  selectScenario,
  sortRoutes,
} from '../../shared/mockScenarios.js';

describe('normalizeMockConfig', () => {
  it('fills defaults for legacy requests and preserves order', () => {
    const config = normalizeMockConfig(undefined);
    expect(config).toEqual({
      enabled: true,
      mode: 'auto',
      activeScenarioId: null,
      scenarios: [],
    });

    const scenarios = normalizeMockConfig({
      mode: 'manual',
      activeScenarioId: 'b',
      scenarios: [
        { id: 'a', name: 'A', conditions: [{ source: 'query', key: 'x', operator: 'equals', value: '1' }] },
        { id: 'b', name: 'B', isDefault: true },
      ],
    }).scenarios;
    expect(scenarios.map((s) => s.name)).toEqual(['A', 'B']);
    expect(scenarios[0].conditions[0]).toMatchObject({ source: 'query', key: 'x' });
    expect(scenarios[1].isDefault).toBe(true);
  });

  it('drops invalid conditions, clamps status/delay, and dedupes ids', () => {
    const config = normalizeMockConfig({
      activeScenarioId: 'missing',
      scenarios: [
        {
          id: 'dup',
          name: '',
          status: 999,
          delayMs: -5,
          conditions: [
            { source: 'nope', key: 'x', operator: 'equals', value: '1' },
            { source: 'body', key: '', operator: 'equals', value: '1' },
            { source: 'header', key: 'X', operator: 'regex', value: 'x' },
          ],
        },
        { id: 'dup', name: 'Second' },
      ],
    });
    expect(config.activeScenarioId).toBeNull();
    expect(config.scenarios[0].status).toBe(200);
    expect(config.scenarios[0].delayMs).toBe(0);
    expect(config.scenarios[0].conditions).toEqual([
      { source: 'body', key: '', operator: 'equals', value: '1', enabled: true },
    ]);
    expect(config.scenarios[1].id).toBe('dup-2');
  });
});

describe('routing', () => {
  const routes = sortRoutes([
    { ...compileRoute('/users/:id'), method: 'GET', order: 0 },
    { ...compileRoute('/users/me'), method: 'GET', order: 1 },
    { ...compileRoute('/users/{id}/posts'), method: 'GET', order: 2 },
  ]);

  it('normalizes URL forms', () => {
    expect(pathnameOf('https://api.test/users/1?x=1')).toBe('/users/1');
    expect(pathnameOf('{{baseUrl}}/users/1')).toBe('/users/1');
    expect(pathnameOf('api.test/users/1')).toBe('/users/1');
    expect(normalizePath('/a/')).toBe('/a');
  });

  it('prefers exact and more literal routes', () => {
    expect(matchRoutes(routes, 'GET', '/users/me').route.path).toBe('/users/me');
    expect(matchRoutes(routes, 'GET', '/users/42').route.path).toBe('/users/:id');
    expect(matchRoutes(routes, 'GET', '/users/42/posts').route.path).toBe('/users/{id}/posts');
    expect(matchRoutes(routes, 'POST', '/users/42')).toBeNull();
  });

  it('captures and decodes path params', () => {
    const match = matchRoutes(routes, 'GET', '/users/a%20b/posts');
    expect(match.params).toEqual({ id: 'a b' });
  });
});

describe('conditions', () => {
  const ctx = {
    query: new URLSearchParams('state=ok&empty='),
    headers: { 'X-Mode': 'fast' },
    body: { user: { role: 'admin', age: 42 } },
    path: { id: '7' },
  };

  it('evaluates every operator', () => {
    expect(evaluateCondition({ source: 'query', key: 'state', operator: 'equals', value: 'ok' }, ctx)).toBe(true);
    expect(evaluateCondition({ source: 'query', key: 'state', operator: 'not_equals', value: 'no' }, ctx)).toBe(true);
    expect(evaluateCondition({ source: 'query', key: 'state', operator: 'contains', value: 'k' }, ctx)).toBe(true);
    expect(evaluateCondition({ source: 'query', key: 'state', operator: 'not_contains', value: 'z' }, ctx)).toBe(true);
    expect(evaluateCondition({ source: 'header', key: 'x-mode', operator: 'equals', value: 'fast' }, ctx)).toBe(true);
    expect(evaluateCondition({ source: 'body', key: 'user.role', operator: 'equals', value: 'admin' }, ctx)).toBe(true);
    expect(evaluateCondition({ source: 'body', key: 'user.age', operator: 'gt', value: '40' }, ctx)).toBe(true);
    expect(evaluateCondition({ source: 'body', key: 'user.age', operator: 'lt', value: '50' }, ctx)).toBe(true);
    expect(evaluateCondition({ source: 'path', key: 'id', operator: 'equals', value: '7' }, ctx)).toBe(true);
    expect(evaluateCondition({ source: 'query', key: 'missing', operator: 'not_exists', value: '' }, ctx)).toBe(true);
    expect(evaluateCondition({ source: 'query', key: 'empty', operator: 'exists', value: '' }, ctx)).toBe(false);
    expect(evaluateCondition({ source: 'query', key: '', operator: 'exists', value: '' }, ctx)).toBe(false);
  });
});

describe('selectScenario', () => {
  const config = {
    mode: 'auto',
    scenarios: [
      {
        id: 'ok',
        name: 'OK',
        conditions: [{ source: 'query', key: 'state', operator: 'equals', value: 'ok' }],
      },
      { id: 'fallback', name: 'Fallback', isDefault: true },
      { id: 'never', name: 'No conditions' },
    ],
  };
  const ctx = { query: new URLSearchParams('state=ok'), headers: {}, body: null, path: {} };

  it('uses the first matching condition in auto mode', () => {
    expect(selectScenario(config, ctx)).toMatchObject({ scenario: { id: 'ok' }, reason: 'condition' });
  });

  it('falls back to the default scenario, never an empty-condition scenario', () => {
    expect(
      selectScenario(config, { ...ctx, query: new URLSearchParams('state=no') })
    ).toMatchObject({ scenario: { id: 'fallback' }, reason: 'default' });
  });

  it('uses a valid manual selection, or the default when stale', () => {
    expect(selectScenario({ ...config, mode: 'manual', activeScenarioId: 'ok' }, ctx)).toMatchObject({
      scenario: { id: 'ok' },
      reason: 'manual',
    });
    expect(
      selectScenario({ ...config, mode: 'manual', activeScenarioId: 'missing' }, ctx)
    ).toMatchObject({ scenario: { id: 'fallback' }, reason: 'default' });
  });
});

describe('templates and body detection', () => {
  it('substitutes request values and stringifies objects', () => {
    const ctx = {
      query: new URLSearchParams('q=hello'),
      headers: { 'X-Id': 'abc' },
      body: { user: { id: 9 } },
      path: { id: '3' },
    };
    expect(
      renderMockTemplate('{{request.query.q}} {{request.header.x-id}} {{request.path.id}} {{request.body.user}}', ctx)
    ).toBe('hello abc 3 {"id":9}');
    expect(renderMockTemplate('{{request.query.missing}}!', ctx)).toBe('!');
  });

  it('detects when a request body is needed', () => {
    expect(
      configNeedsBody({
        scenarios: [
          { conditions: [{ source: 'query', key: 'x', operator: 'exists', value: '' }], body: '' },
        ],
      })
    ).toBe(false);
    expect(
      configNeedsBody({
        scenarios: [
          { conditions: [{ source: 'body', key: 'x', operator: 'exists', value: '' }], body: '' },
        ],
      })
    ).toBe(true);
    expect(
      configNeedsBody({
        scenarios: [{ conditions: [], body: '{{request.body.id}}' }],
      })
    ).toBe(true);
  });
});
