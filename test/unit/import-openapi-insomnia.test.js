import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fromOpenApi } from '../../src/lib/import/openapi.js';
import { fromInsomnia } from '../../src/lib/import/insomnia.js';
import { normalizeCollection } from '../../src/lib/collectionTree.js';

const fixture = (p) => JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'fixtures', p), 'utf8'));

function requestsOf(node) {
  const out = [];
  for (const item of node.items || []) {
    if (item.type === 'folder') out.push(...requestsOf(item));
    else out.push(item);
  }
  return out;
}

function requestNamed(collection, name) {
  return requestsOf(collection).find((request) => request.name === name);
}

describe('fromOpenApi (OpenAPI 3)', () => {
  const { collection } = fromOpenApi(fixture('import/petstore-openapi.json'));

  it('groups one request per operation into tag folders', () => {
    expect(collection.name).toBe('Petstore');
    expect(collection.items).toHaveLength(2);

    const folders = collection.items.filter((item) => item.type === 'folder');
    expect(folders.map((f) => f.name)).toEqual(['pets', 'store']);
    expect(folders.find((f) => f.name === 'pets').items).toHaveLength(2);
    expect(folders.find((f) => f.name === 'store').items).toHaveLength(1);
    expect(requestsOf(collection)).toHaveLength(3);
  });

  it('resolves the server URL through its variable defaults', () => {
    for (const request of requestsOf(collection)) {
      expect(request.url.startsWith('https://api.example.com/v1')).toBe(true);
    }
    expect(requestNamed(collection, 'listPets').url).toBe('https://api.example.com/v1/pets');
  });

  it('maps query params with their defaults', () => {
    const list = requestNamed(collection, 'listPets');
    expect(list.method).toBe('GET');
    expect(list.params).toHaveLength(1);
    expect(list.params[0]).toMatchObject({ key: 'limit', value: '20', enabled: true });
  });

  it('converts `{petId}` to a path variable and keeps param examples', () => {
    const order = requestNamed(collection, 'getOrder');
    expect(order.url).toBe('https://api.example.com/v1/store/orders/:petId');
    expect(order.pathVars).toEqual([{ key: 'petId', value: 'pet_1' }]);
  });

  it('builds a JSON body from a $ref schema and sets Content-Type', () => {
    const create = requestNamed(collection, 'createPet');
    expect(create.method).toBe('POST');
    expect(create.body.mode).toBe('json');
    expect(JSON.parse(create.body.raw)).toHaveProperty('name');

    const contentType = create.headers.find(
      (header) => String(header.key).toLowerCase() === 'content-type'
    );
    expect(contentType?.value).toBe('application/json');
  });

  it('puts document security on the collection auth', () => {
    expect(collection.auth.type).toBe('bearer');
    expect(collection.auth.bearer.token).toBe('{{token}}');
  });

  it('survives normalizeCollection without losing the tree', () => {
    const normalized = normalizeCollection(collection);
    expect(normalized.id).toBe(collection.id);
    expect(requestsOf(normalized)).toHaveLength(3);
    expect(normalized.auth.type).toBe('bearer');
  });
});

describe('fromOpenApi (Swagger 2.0)', () => {
  const { collection } = fromOpenApi(fixture('import/petstore-swagger2.json'));

  it('builds the base URL from scheme + host + basePath', () => {
    const requests = requestsOf(collection);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url.startsWith('https://api.example.com/v1/pets')).toBe(true);
    }
  });

  it('builds a JSON body from #/definitions', () => {
    const create = requestNamed(collection, 'createPet');
    expect(create.method).toBe('POST');
    expect(create.body.mode).toBe('json');
    const parsed = JSON.parse(create.body.raw);
    expect(parsed).toHaveProperty('name', 'doggie');
    expect(create.params[0]).toMatchObject({ key: 'verbose', value: 'false' });

    const filter = requestNamed(collection, 'getPetsWithBody');
    expect(filter.method).toBe('GET');
    expect(filter.body.mode).toBe('json');
    expect(JSON.parse(filter.body.raw)).toHaveProperty('name');
  });

  it('maps apiKey security to collection auth', () => {
    expect(collection.auth.type).toBe('apikey');
    expect(collection.auth.apikey).toMatchObject({
      key: 'X-API-Key',
      value: '{{apiKey}}',
      addTo: 'header',
    });
  });
});

describe('fromInsomnia', () => {
  const { collection, environments } = fromInsomnia(fixture('import/insomnia-v4.json'));

  it('honors request_group nesting via parentId', () => {
    expect(collection.name).toBe('Demo Workspace');
    expect(collection.items).toHaveLength(1);

    const folder = collection.items[0];
    expect(folder.type).toBe('folder');
    expect(folder.name).toBe('Pets');
    expect(folder.items).toHaveLength(2);
    expect(requestsOf(collection)).toHaveLength(2);
  });

  it('maps requests, headers, params, auth, and bodies', () => {
    const list = requestNamed(collection, 'List pets');
    expect(list.method).toBe('GET');
    expect(list.url).toBe('https://api.example.com/pets?limit=20');
    expect(list.headers[0]).toMatchObject({ key: 'Accept', value: 'application/json', enabled: true });
    expect(list.auth.type).toBe('basic');
    expect(list.auth.basic).toMatchObject({ username: 'user', password: 'pass' });

    const create = requestNamed(collection, 'Create pet');
    expect(create.method).toBe('POST');
    expect(create.auth.type).toBe('bearer');
    expect(create.auth.bearer.token).toBe('{{token}}');
    expect(create.body.mode).toBe('json');
    expect(JSON.parse(create.body.raw)).toMatchObject({ name: 'doggie' });
  });

  it('imports environments and skips `__` keys', () => {
    expect(environments).toHaveLength(1);
    const [env] = environments;
    expect(env.name).toBe('Development');
    expect(env.variables).toEqual([
      { key: 'baseUrl', value: 'https://api.example.com', enabled: true },
      { key: 'apiKey', value: 'dev-key', enabled: true },
    ]);
  });

  it('ignores api_spec resources and survives normalizeCollection', () => {
    const allNames = collection.items.flatMap((item) => [
      item.name,
      ...(item.items || []).map((child) => child.name),
    ]);
    expect(allNames).not.toContain('Pets OpenAPI');
    expect(allNames).not.toContain('Development');

    const normalized = normalizeCollection(collection);
    expect(normalized.items[0].items).toHaveLength(2);
  });
});
