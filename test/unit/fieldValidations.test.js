import { describe, expect, it } from 'vitest';
import {
  bodyValidationFields,
  collectValidationFields,
  countValidatedFields,
  hasFieldValidations,
  hasValidation,
  minMaxLabels,
  normalizeFieldValidations,
  normalizeValidationRule,
  validationTokens,
} from '../../src/lib/fieldValidations.js';

describe('field validation normalization', () => {
  it('normalizes every section and drops empty rules', () => {
    const out = normalizeFieldValidations({
      path: { id: { rules: ['required'] } },
      params: { q: { rules: ['string', 'string', 'not valid!', 'required', 'max:100'] } },
      headers: { 'X-Empty': { rules: [], min: 0, max: 0, description: '  ' } },
      body: {
        'user.email': {
          rules: ['email', 'required'],
          min: '-2',
          max: '64.9',
          description: 'Primary email',
        },
      },
      ignored: { x: { rules: ['required'] } },
    });

    expect(Object.keys(out)).toEqual(['path', 'params', 'headers', 'body']);
    expect(out.path.id.rules).toEqual(['required']);
    expect(out.params.q.rules).toEqual(['required', 'string', 'max:100']);
    expect(out.headers['X-Empty']).toBeUndefined();
    expect(out.body['user.email']).toMatchObject({
      rules: ['required', 'email'],
      min: 0,
      max: 64,
      description: 'Primary email',
    });
    expect(out.ignored).toBeUndefined();
  });

  it('keeps description-only metadata and accepts empty input', () => {
    const out = normalizeFieldValidations({
      headers: { 'X-Note': { description: 'Optional' } },
    });
    expect(out.headers['X-Note']).toMatchObject({
      rules: [],
      min: 0,
      max: 0,
      description: 'Optional',
    });
    expect(hasValidation(out.headers['X-Note'])).toBe(true);
    expect(hasFieldValidations(out)).toBe(true);
    expect(countValidatedFields(out)).toBe(1);

    const empty = normalizeFieldValidations(undefined);
    expect(empty).toEqual({ path: {}, params: {}, headers: {}, body: {} });
    expect(hasFieldValidations(empty)).toBe(false);
    expect(normalizeValidationRule(null)).toMatchObject({
      rules: [],
      min: 0,
      max: 0,
      description: '',
    });
  });

  it('normalizes standard JSON Schema constraints and renders tokens', () => {
    const rule = normalizeValidationRule({
      rules: ['string'],
      minLength: 2,
      maxLength: 12,
      pattern: '^[a-z]+$',
      format: 'email',
      enum: ['a', 'b', 'a'],
      example: 'ada@test.dev',
      default: 'a',
    });
    expect(rule).toMatchObject({
      minLength: 2,
      maxLength: 12,
      pattern: '^[a-z]+$',
      format: 'email',
      enum: ['a', 'b'],
      example: 'ada@test.dev',
      default: 'a',
    });
    expect(validationTokens(rule)).toEqual(
      expect.arrayContaining(['STRING', 'MIN LENGTH 2', 'MAX LENGTH 12', 'PATTERN', 'FORMAT EMAIL', 'ENUM 2', 'EXAMPLE', 'DEFAULT'])
    );
  });

  it('labels min/max according to the field type', () => {
    expect(minMaxLabels({ rules: ['integer'] })).toEqual({ min: 'Min value', max: 'Max value' });
    expect(minMaxLabels({ rules: ['string'] })).toEqual({ min: 'Min length', max: 'Max length' });
    expect(minMaxLabels({ rules: ['array'] })).toEqual({ min: 'Min items', max: 'Max items' });
    expect(minMaxLabels({ rules: [] })).toEqual({ min: 'Min', max: 'Max' });
  });

  it('produces deterministic badge tokens', () => {
    const rule = normalizeValidationRule({
      rules: ['string', 'required'],
      min: 3,
      max: 32,
      description: 'slug',
    });
    expect(validationTokens(rule)).toEqual(['REQUIRED', 'STRING', 'MIN 3', 'MAX 32']);
    expect(validationTokens(null)).toEqual([]);
  });
});

describe('request field discovery', () => {
  it('collects path, query, header and nested JSON body fields', () => {
    const request = {
      url: 'https://api.test/users/:id/{slug}?q=1',
      pathVars: [{ key: 'id', value: '42', enabled: true }],
      params: [
        { key: 'q', value: 'ada', enabled: true },
        { key: 'skip', value: 'me', enabled: false },
      ],
      headers: [
        { key: 'X-Tenant', value: 'acme', enabled: true },
        { key: 'X-Skip', value: 'no', enabled: false },
      ],
      body: {
        mode: 'json',
        raw: JSON.stringify({
          user: { email: 'ada@test.dev', tags: ['a', 'b'] },
          empty: {},
          active: true,
        }),
      },
    };

    const fields = collectValidationFields(request);
    expect(fields.path).toEqual([
      { key: 'id', value: '42' },
      { key: 'slug', value: '' },
    ]);
    expect(fields.params).toEqual([{ key: 'q', value: 'ada' }]);
    expect(fields.headers).toEqual([{ key: 'X-Tenant', value: 'acme' }]);
    expect(fields.body).toEqual([
      { key: 'user.email', value: 'ada@test.dev' },
      { key: 'user.tags', value: '["a","b"]' },
      { key: 'empty', value: '{}' },
      { key: 'active', value: 'true' },
    ]);
  });

  it('ignores host variables and query braces when finding path params', () => {
    const fields = collectValidationFields({
      url: '{{baseUrl}}/users/{{id}}?filter={name}',
      pathVars: [],
      params: [],
      headers: [],
      body: { mode: 'none' },
    });
    expect(fields.path).toEqual([{ key: 'id', value: '' }]);
  });

  it('supports form and GraphQL bodies and ignores invalid JSON', () => {
    const form = {
      mode: 'form-urlencoded',
      form: [
        { key: 'name', value: 'Ada', enabled: true },
        { key: 'skip', value: 'no', enabled: false },
      ],
    };
    expect(bodyValidationFields(form)).toEqual([{ key: 'name', value: 'Ada' }]);

    expect(
      bodyValidationFields({
        mode: 'graphql',
        graphql: { variables: '{"id":7}' },
      })
    ).toEqual([{ key: 'id', value: '7' }]);

    expect(bodyValidationFields({ mode: 'raw', raw: 'not json' })).toEqual([]);
  });
});
