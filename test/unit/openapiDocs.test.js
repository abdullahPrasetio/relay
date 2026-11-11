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
          schema: { type: 'object', example: { sku: 'A-1', qty: 2 } },
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
