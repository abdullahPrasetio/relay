import { describe, expect, it } from 'vitest';
import {
  INTROSPECTION_QUERY,
  buildIntrospectionRequest,
  parseIntrospection,
  graphqlCompletions,
} from '../../src/lib/graphql.js';

// A realistic introspection payload containing wrappers, args, a mutation,
// no subscription, and introspection machinery types that must be dropped.
const INTROSPECTION_PAYLOAD = {
  data: {
    __schema: {
      queryType: { name: 'Query' },
      mutationType: { name: 'Mutation' },
      subscriptionType: null,
      types: [
        {
          kind: 'OBJECT',
          name: 'Query',
          fields: [
            {
              name: 'user',
              args: [{ name: 'id' }],
              type: { kind: 'OBJECT', name: 'User', ofType: null },
            },
            {
              name: 'users',
              args: [{ name: 'first' }],
              type: {
                kind: 'NON_NULL',
                name: null,
                ofType: {
                  kind: 'LIST',
                  name: null,
                  ofType: { kind: 'OBJECT', name: 'User', ofType: null },
                },
              },
            },
          ],
        },
        {
          kind: 'OBJECT',
          name: 'User',
          fields: [
            {
              name: 'id',
              args: [],
              type: {
                kind: 'NON_NULL',
                name: null,
                ofType: { kind: 'SCALAR', name: 'ID', ofType: null },
              },
            },
            {
              name: 'name',
              args: [],
              type: { kind: 'SCALAR', name: 'String', ofType: null },
            },
          ],
        },
        {
          kind: 'OBJECT',
          name: 'Mutation',
          fields: [
            {
              name: 'createUser',
              args: [{ name: 'input' }],
              type: { kind: 'OBJECT', name: 'User', ofType: null },
            },
          ],
        },
        { kind: 'SCALAR', name: 'String', fields: null },
        { kind: 'SCALAR', name: 'ID', fields: null },
        {
          kind: 'OBJECT',
          name: '__Type',
          fields: [{ name: 'name', args: [], type: { kind: 'SCALAR', name: 'String' } }],
        },
      ],
    },
  },
};

function parseFixture() {
  return parseIntrospection(INTROSPECTION_PAYLOAD);
}

function labels(items) {
  return items.map((item) => item.label);
}

describe('buildIntrospectionRequest', () => {
  it('builds a POST request accepted by the engine', () => {
    const req = buildIntrospectionRequest({
      url: 'https://api.example.com/graphql',
      headers: [{ key: 'Authorization', value: 'Bearer token', enabled: true }],
    });

    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://api.example.com/graphql');
    expect(req.body.mode).toBe('json');
    expect(JSON.parse(req.body.raw).query).toBe(INTROSPECTION_QUERY);
    expect(INTROSPECTION_QUERY).toContain('__schema');
    expect(INTROSPECTION_QUERY).toContain('types');
  });

  it('applies Content-Type and drops disabled headers', () => {
    const req = buildIntrospectionRequest({
      url: 'https://api.example.com/graphql',
      headers: [
        { key: 'Authorization', value: 'Bearer token', enabled: true },
        { key: 'X-Disabled', value: 'nope', enabled: false },
        { key: '', value: 'empty', enabled: true },
      ],
    });

    const keys = req.headers.map((header) => header.key.toLowerCase());
    expect(keys).toContain('authorization');
    expect(keys).not.toContain('x-disabled');
    expect(keys.filter((key) => key === 'content-type')).toHaveLength(1);
    expect(req.headers.find((header) => header.key === 'Content-Type').value).toBe(
      'application/json'
    );
  });

  it('does not duplicate or override an explicit Content-Type', () => {
    const req = buildIntrospectionRequest({
      url: 'https://api.example.com/graphql',
      headers: [{ key: 'content-type', value: 'application/graphql+json' }],
    });

    const contentTypes = req.headers.filter(
      (header) => header.key.toLowerCase() === 'content-type'
    );
    expect(contentTypes).toHaveLength(1);
    expect(contentTypes[0].value).toBe('application/graphql+json');
  });

  it('accepts a plain header object and tolerates a missing URL', () => {
    const req = buildIntrospectionRequest({ headers: { 'X-Api-Key': 'k' } });
    expect(req.url).toBe('');
    expect(req.headers.find((header) => header.key === 'X-Api-Key').value).toBe('k');
    expect(req.headers.some((header) => header.key === 'Content-Type')).toBe(true);
  });
});

describe('parseIntrospection', () => {
  it('extracts types, fields, args, and root fields', () => {
    const schema = parseFixture();

    expect(schema.error).toBeUndefined();
    expect(schema.rootTypes).toEqual({
      query: 'Query',
      mutation: 'Mutation',
      subscription: null,
    });
    expect(schema.rootFields).toEqual({
      query: ['user', 'users'],
      mutation: ['createUser'],
      subscription: [],
    });

    const names = schema.types.map((type) => type.name);
    expect(names).toContain('Query');
    expect(names).toContain('User');
    expect(names).not.toContain('__Type');

    const query = schema.types.find((type) => type.name === 'Query');
    const userField = query.fields.find((field) => field.name === 'user');
    expect(userField.args).toEqual(['id']);
    expect(userField.type).toBe('User');

    const usersField = query.fields.find((field) => field.name === 'users');
    // NON_NULL/LIST wrappers are unwrapped to the named type.
    expect(usersField.type).toBe('User');

    const user = schema.types.find((type) => type.name === 'User');
    expect(user.fields.find((field) => field.name === 'id').type).toBe('ID');

    expect(schema.fieldNames).toContain('user');
    expect(schema.fieldNames).toContain('createUser');
    expect(new Set(schema.fieldNames).size).toBe(schema.fieldNames.length);
  });

  it('accepts a JSON string body', () => {
    const schema = parseIntrospection(JSON.stringify(INTROSPECTION_PAYLOAD));
    expect(schema.rootFields.query).toEqual(['user', 'users']);
  });

  it('accepts a bare __schema object', () => {
    const schema = parseIntrospection(INTROSPECTION_PAYLOAD.data);
    expect(schema.rootFields.query).toEqual(['user', 'users']);
  });

  it('returns the GraphQL error when no schema is present', () => {
    const schema = parseIntrospection({
      errors: [{ message: 'Cannot query field "__schema" on type "Query"' }],
    });
    expect(schema.error).toBe('Cannot query field "__schema" on type "Query"');
    expect(schema.types).toEqual([]);
    expect(schema.rootFields).toEqual({ query: [], mutation: [], subscription: [] });
  });

  it('tolerates partial data alongside errors', () => {
    const schema = parseIntrospection({
      ...INTROSPECTION_PAYLOAD,
      errors: [{ message: 'Resolver for users failed' }],
    });
    expect(schema.error).toBeUndefined();
    expect(schema.errors).toEqual(['Resolver for users failed']);
    expect(schema.rootFields.query).toEqual(['user', 'users']);
  });

  it('does not crash on garbage input', () => {
    for (const input of ['not json', null, undefined, 42, [], {}, { data: null }]) {
      const schema = parseIntrospection(input);
      expect(schema.types).toEqual([]);
      expect(schema.error).toBeTruthy();
    }
  });

  it('falls back to a conventional root type when queryType is omitted', () => {
    const schema = parseIntrospection({
      data: {
        __schema: {
          types: [
            {
              kind: 'OBJECT',
              name: 'Query',
              fields: [{ name: 'ping', args: [], type: { name: 'String' } }],
            },
          ],
        },
      },
    });
    expect(schema.rootTypes.query).toBe('Query');
    expect(schema.rootFields.query).toEqual(['ping']);
  });

  it('handles a partial schema with no types', () => {
    const schema = parseIntrospection({
      data: { __schema: { queryType: { name: 'Query' } } },
    });
    expect(schema.error).toBeUndefined();
    expect(schema.types).toEqual([]);
    expect(schema.rootFields.query).toEqual([]);
  });
});

describe('graphqlCompletions', () => {
  it('returns root fields inside a query operation', () => {
    const schema = parseFixture();
    expect(labels(graphqlCompletions({ schema, word: '', linePrefix: 'query {\n  ' }))).toEqual([
      'user',
      'users',
    ]);
    expect(labels(graphqlCompletions({ schema, word: '', linePrefix: 'query Foo {\n  ' }))).toEqual([
      'user',
      'users',
    ]);
    expect(labels(graphqlCompletions({ schema, word: '', linePrefix: '{\n  ' }))).toEqual([
      'user',
      'users',
    ]);
  });

  it('includes the field return type and args in the detail', () => {
    const schema = parseFixture();
    const items = graphqlCompletions({ schema, word: 'user', linePrefix: 'query {\n  user' });
    const user = items.find((item) => item.label === 'user');
    expect(user.detail).toBe('User(id)');
  });

  it('suggests fields of the enclosing type for nested selections', () => {
    const schema = parseFixture();
    const items = graphqlCompletions({
      schema,
      word: '',
      linePrefix: 'query {\n  user {\n    ',
    });
    expect(labels(items)).toEqual(['id', 'name']);
    expect(labels(items)).not.toContain('user');
  });

  it('suggests fields for fragments and inline fragments', () => {
    const schema = parseFixture();
    expect(
      labels(
        graphqlCompletions({ schema, word: '', linePrefix: 'fragment UserFields on User {\n  ' })
      )
    ).toEqual(['id', 'name']);
    expect(
      labels(graphqlCompletions({ schema, word: '', linePrefix: 'query {\n  ... on User {\n    ' }))
    ).toEqual(['id', 'name']);
  });

  it('suggests operation keywords and type names at the top level', () => {
    const schema = parseFixture();
    const items = labels(graphqlCompletions({ schema, word: '', linePrefix: '' }));
    expect(items).toContain('query');
    expect(items).toContain('mutation');
    // No subscription root type exists.
    expect(items).not.toContain('subscription');
    expect(items).toContain('Query');
    expect(items).toContain('User');
  });

  it('suggests type names in an "on" type position', () => {
    const schema = parseFixture();
    const items = labels(
      graphqlCompletions({ schema, word: '', linePrefix: 'fragment F on ' })
    );
    expect(items).toContain('User');
    expect(items).toContain('Query');
  });

  it('filters by the current word', () => {
    const schema = parseFixture();
    expect(
      labels(graphqlCompletions({ schema, word: 'us', linePrefix: 'query {\n  us' }))
    ).toEqual(['user', 'users']);
  });

  it('deduplicates repeated labels', () => {
    const schema = {
      types: [
        {
          name: 'Query',
          kind: 'OBJECT',
          fields: [
            { name: 'user', args: [], type: 'User' },
            { name: 'user', args: [], type: 'User' },
          ],
        },
        { name: 'User', kind: 'OBJECT', fields: [] },
      ],
      rootFields: { query: ['user', 'user'], mutation: [], subscription: [] },
      rootTypes: { query: 'Query', mutation: null, subscription: null },
    };
    const items = labels(graphqlCompletions({ schema, word: '', linePrefix: 'query {' }));
    expect(items).toEqual(['user']);
  });

  it('returns an empty array for an empty or missing schema', () => {
    expect(graphqlCompletions({ schema: null, word: '', linePrefix: 'query {' })).toEqual([]);
    expect(graphqlCompletions({ schema: { types: [] }, word: '', linePrefix: 'query {' })).toEqual(
      []
    );
    expect(graphqlCompletions({})).toEqual([]);
  });

  it('does not crash on partial or malformed lines', () => {
    const schema = parseFixture();
    for (const linePrefix of [
      'query',
      'query ',
      'query {',
      'query Foo(',
      'query Foo($id: ID!) {',
      'query { user(id: "1',
      'user {',
      '{{baseUrl}}',
      '# comment {\nquery {',
      '"""unterminated',
    ]) {
      const items = graphqlCompletions({ schema, word: '', linePrefix });
      expect(Array.isArray(items)).toBe(true);
      for (const item of items) {
        expect(typeof item.label).toBe('string');
        expect(typeof item.insertText).toBe('string');
        expect(typeof item.detail).toBe('string');
      }
    }
  });
});
