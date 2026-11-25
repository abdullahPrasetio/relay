import { describe, expect, it } from 'vitest';
import { generateJsonSchema, generateJsonSchemaText } from '../../src/lib/jsonSchema.js';

describe('JSON schema generation', () => {
  it('infers object properties and required keys', () => {
    const schema = generateJsonSchema({
      bizId: 'BRIMERCHANT',
      amount: 1500,
      active: true,
      tags: ['a', 'b'],
      owner: { name: 'Ada' },
    });
    expect(schema).toEqual({
      type: 'object',
      properties: {
        bizId: { type: 'string' },
        amount: { type: 'integer' },
        active: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
        owner: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      },
      required: ['bizId', 'amount', 'active', 'tags', 'owner'],
    });
  });

  it('merges array item shapes and falls back for mixed arrays', () => {
    expect(generateJsonSchema([{ id: 1 }, { id: 2, name: 'x' }]).items).toEqual({
      type: 'object',
      properties: {
        id: { type: 'integer' },
        name: { type: 'string' },
      },
      required: ['id', 'name'],
    });
    expect(generateJsonSchema([1, 'x']).items).toEqual({});
  });

  it('parses body text and returns pretty schema JSON', () => {
    expect(JSON.parse(generateJsonSchemaText('{"id":1}'))).toEqual({
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
    });
    expect(() => generateJsonSchemaText('{')).toThrow();
  });
});
