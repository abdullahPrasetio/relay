import { describe, expect, it } from 'vitest';
import { collectionToOpenApi, requestPath } from '../../src/lib/openapiDocs.js';

function fixture() {
  return {
    name: 'Orders API',
    description: 'Order endpoints',
    items: [
      {
        type: 'folder',
        name: 'Orders',
        items: [
          {
            id: 'req_1',
            type: 'request',
            name: 'Create order',
            method: 'POST',
            url: 'https://api.test/orders/:id?expand=items',
            description: 'Creates an order',
            pathVars: [{ key: 'id', value: '42', enabled: true }],
            params: [
              { key: 'expand', value: 'items', enabled: true },
              { key: 'ignored', value: 'no', enabled: false },
            ],
            headers: [
              { key: 'X-Tenant', value: 'acme', enabled: true },
              { key: 'Authorization', value: 'Bearer secret', enabled: true },
            ],
            body: { mode: 'json', raw: '{"sku":"A-1","qty":2}' },
            examples: [
              {
                name: 'Created',
                response: {
                  status: 201,
                  statusText: 'Created',
                  contentType: 'application/json',
                  headers: [{ key: 'Location', value: '/orders/42' }],
                  body: '{"id":42}',
                },
              },
              {
                name: 'Invalid',
                response: {
                  status: 422,
                  contentType: 'application/json',
                  body: '{"error":"sku"}',
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('requestPath', () => {
  it('normalizes absolute URLs, variables and path parameters', () => {
    expect(requestPath('https://api.test/users/:id?q=1')).toBe('/users/{id}');
    expect(requestPath('{{baseUrl}}/users/{{userId}}')).toBe('/users/{userId}');
    expect(requestPath('https://api.test')).toBe('/');
    expect(requestPath('')).toBe('/');
  });
});

describe('collectionToOpenApi', () => {
  it('builds paths, parameters, body and responses', () => {
    const spec = collectionToOpenApi(fixture());
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.info).toEqual({
      title: 'Orders API',
      description: 'Order endpoints',
      version: '1.0.0',
    });
    expect(spec.tags).toEqual([{ name: 'Orders' }]);

    const operation = spec.paths['/orders/{id}'].post;
    expect(operation.summary).toBe('Create order');
    expect(operation.description).toBe('Creates an order');
    expect(operation.tags).toEqual(['Orders']);

    expect(operation.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string' }, example: '42' },
      {
        name: 'expand',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        example: 'items',
      },
      {
        name: 'X-Tenant',
        in: 'header',
        required: false,
        schema: { type: 'string' },
        example: 'acme',
      },
    ]);

    expect(operation.requestBody).toEqual({
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            example: { sku: 'A-1', qty: 2 },
            properties: {
              sku: { type: 'string', example: 'A-1' },
              qty: { type: 'integer', example: 2 },
            },
          },
        },
      },
    });

    expect(operation.responses['201'].description).toBe('Created');
    expect(operation.responses['201'].headers).toEqual({
      Location: { schema: { type: 'string' }, example: '/orders/42' },
    });
    expect(
      operation.responses['201'].content['application/json'].examples.Created.value
    ).toEqual({ id: 42 });
    expect(operation.responses['422'].description).toBe('Unprocessable Entity');
  });

  it('maps validation metadata into OpenAPI parameters and body schema', () => {
    const spec = collectionToOpenApi({
      name: 'Validated',
      items: [
        {
          id: 'req_v',
          type: 'request',
          name: 'Validated create',
          method: 'POST',
          url: 'https://api.test/items/:id',
          params: [{ key: 'page', value: '1', enabled: true }],
          headers: [{ key: 'X-Tenant', value: 'acme', enabled: true }],
          body: { mode: 'json', raw: '{"id":1,"status":"NEW","email":"a@test.dev"}' },
          fieldValidations: {
            path: { id: { rules: ['required', 'string'], minLength: 2 } },
            params: {
              page: { rules: ['required', 'integer'], min: 1, max: 10, description: 'Page' },
            },
            headers: {
              'X-Tenant': { rules: ['string'], minLength: 2, maxLength: 20, pattern: '^[a-z]+$' },
            },
            body: {
              id: { rules: ['required', 'integer'], min: 1, max: 10 },
              status: { rules: ['string'], enum: ['NEW', 'PAID'] },
              email: { rules: ['email'] },
            },
          },
        },
      ],
    });
    const operation = spec.paths['/items/{id}'].post;
    expect(operation.parameters).toEqual([
      {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string', minLength: 2 },
      },
      {
        name: 'page',
        in: 'query',
        required: true,
        schema: { type: 'integer', minimum: 1, maximum: 10 },
        example: '1',
        description: 'Page',
      },
      {
        name: 'X-Tenant',
        in: 'header',
        required: false,
        schema: { type: 'string', minLength: 2, maxLength: 20, pattern: '^[a-z]+$' },
        example: 'acme',
      },
    ]);
    const schema = operation.requestBody.content['application/json'].schema;
    expect(schema.required).toEqual(['id']);
    expect(schema.properties.id).toMatchObject({ type: 'integer', minimum: 1, maximum: 10 });
    expect(schema.properties.status).toMatchObject({ type: 'string', enum: ['NEW', 'PAID'] });
    expect(schema.properties.email).toMatchObject({ type: 'string', format: 'email' });
  });

  it('maps nested array body validations into item schemas', () => {
    const spec = collectionToOpenApi({
      name: 'Arrays',
      items: [
        {
          id: 'req_arr',
          type: 'request',
          name: 'Create list',
          method: 'POST',
          url: '/items',
          body: { mode: 'json', raw: '{"items":[{"id":1,"name":"A"}]}' },
          fieldValidations: {
            body: {
              'items[]': { rules: ['array'], minItems: 1 },
              'items[].id': { rules: ['required', 'integer'], minimum: 1 },
              'items[].name': { rules: ['string'], minLength: 1 },
            },
          },
        },
      ],
    });
    const schema = spec.paths['/items'].post.requestBody.content['application/json'].schema;
    expect(schema.properties.items).toMatchObject({ type: 'array', minItems: 1 });
    expect(schema.properties.items.items.required).toEqual(['id']);
    expect(schema.properties.items.items.properties.id).toMatchObject({
      type: 'integer',
      minimum: 1,
    });
    expect(schema.properties.items.items.properties.name).toMatchObject({
      type: 'string',
      minLength: 1,
    });
  });

  it('emits valid regex patterns and omits malformed ones', () => {
    const spec = collectionToOpenApi({
      name: 'Patterns',
      items: [
        {
          type: 'request',
          name: 'Create code',
          method: 'POST',
          url: '/codes',
          body: {
            mode: 'raw',
            raw: '{"code":"AB-1","bad":"x"}',
            contentType: 'application/json',
          },
          fieldValidations: {
            body: {
              code: { rules: ['string'], pattern: '^[A-Z]{2}-\\d+$' },
              bad: { rules: ['string'], pattern: '[' },
            },
          },
        },
      ],
    });
    const schema = spec.paths['/codes'].post.requestBody.content['application/json'].schema;
    expect(schema.properties.code.pattern).toBe('^[A-Z]{2}-\\d+$');
    expect(schema.properties.bad.pattern).toBeUndefined();
  });

  it('inherits collection and folder validations into operations', () => {
    const spec = collectionToOpenApi({
      name: 'Inherited',
      fieldValidations: {
        body: { email: { rules: ['required', 'email'] } },
      },
      items: [
        {
          type: 'folder',
          name: 'Users',
          fieldValidations: {
            headers: { 'X-Key': { rules: ['required'], description: 'Tenant key' } },
          },
          items: [
            {
              id: 'req_inherited',
              type: 'request',
              name: 'Create user',
              method: 'POST',
              url: '/users',
              headers: [{ key: 'X-Key', value: 'abc' }],
              body: {
                mode: 'raw',
                raw: '{"email":"a@example.com"}',
                contentType: 'application/json',
              },
            },
          ],
        },
      ],
    });
    const operation = spec.paths['/users'].post;
    expect(operation.requestBody.content['application/json'].schema).toMatchObject({
      required: ['email'],
      properties: { email: { type: 'string', format: 'email' } },
    });
    expect(operation.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'X-Key',
          in: 'header',
          required: true,
          description: 'Tenant key',
        }),
      ])
    );
  });

  it('maps response validation metadata into response schemas and headers', () => {
    const spec = collectionToOpenApi({
      name: 'Responses',
      items: [
        {
          id: 'req_resp',
          type: 'request',
          name: 'Get item',
          method: 'GET',
          url: '/items/1',
          examples: [
            {
              name: 'OK',
              response: {
                status: 200,
                contentType: 'application/json',
                headers: [{ key: 'X-Trace', value: 'abc' }],
                body: '{"id":1}',
              },
            },
          ],
          responseValidations: {
            body: { id: { rules: ['required', 'integer'], minimum: 1 } },
            headers: { 'X-Trace': { rules: ['string'], minLength: 3 } },
          },
        },
      ],
    });
    const response = spec.paths['/items/1'].get.responses['200'];
    expect(response.content['application/json'].schema).toMatchObject({
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'integer', minimum: 1 } },
    });
    expect(response.headers['X-Trace'].schema).toMatchObject({
      type: 'string',
      minLength: 3,
    });
  });

  it('never emits authorization headers or disabled fields', () => {
    const spec = collectionToOpenApi(fixture());
    const params = spec.paths['/orders/{id}'].post.parameters;
    expect(params.some((p) => p.name.toLowerCase() === 'authorization')).toBe(false);
    expect(params.some((p) => p.name === 'ignored')).toBe(false);
  });

  it('falls back to 200 Success without examples and supports form bodies', () => {
    const spec = collectionToOpenApi({
      name: 'Forms',
      items: [
        {
          id: 'req_2',
          type: 'request',
          name: 'Submit',
          method: 'POST',
          url: '/submit',
          body: {
            mode: 'form-urlencoded',
            form: [
              { key: 'name', value: 'Ada', enabled: true },
              { key: 'skip', value: 'x', enabled: false },
            ],
          },
        },
      ],
    });
    const operation = spec.paths['/submit'].post;
    expect(operation.responses).toEqual({ 200: { description: 'Success' } });
    expect(operation.requestBody.content['application/x-www-form-urlencoded'].schema).toEqual({
      type: 'object',
      example: { name: 'Ada' },
      properties: {
        name: { type: 'string', example: 'Ada' },
      },
    });
  });

  it('merges methods that share a path', () => {
    const spec = collectionToOpenApi({
      name: 'Shared',
      items: [
        { id: 'a', type: 'request', name: 'List', method: 'GET', url: 'https://api.test/items' },
        { id: 'b', type: 'request', name: 'Create', method: 'POST', url: 'https://api.test/items' },
      ],
    });
    expect(Object.keys(spec.paths['/items']).sort()).toEqual(['get', 'post']);
  });
});
