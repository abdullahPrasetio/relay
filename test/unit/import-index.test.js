import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectFormat, importAny, importAs } from '../../src/lib/import/index.js';
import { normalizeCollection } from '../../src/lib/collectionTree.js';

const fixture = (p) => readFileSync(path.join(import.meta.dirname, '..', 'fixtures', p), 'utf8');

// Every converter's output must survive a normalize pass unchanged in shape,
// because that is exactly what happens after import (store load / re-open).
function expectTreeShape(collection) {
  expect(typeof collection.id).toBe('string');
  expect(Array.isArray(collection.items)).toBe(true);
  for (const node of collection.items) {
    expect(['request', 'folder']).toContain(node.type);
    if (node.type === 'folder') expect(Array.isArray(node.items)).toBe(true);
  }
  expect(() => normalizeCollection(collection)).not.toThrow();
}

describe('detectFormat', () => {
  it('detects every supported JSON format', () => {
    expect(detectFormat(fixture('postman/collection-with-events.json'))).toBe('postman');
    expect(detectFormat(fixture('import/petstore-openapi.json'))).toBe('openapi');
    expect(detectFormat(fixture('import/petstore-swagger2.json'))).toBe('swagger2');
    expect(detectFormat(fixture('import/sample.har'))).toBe('har');
    expect(detectFormat(fixture('import/insomnia-v4.json'))).toBe('insomnia');
  });

  it('detects cURL only when the command starts with the verb', () => {
    expect(detectFormat(fixture('import/curl-get-auth.sh'))).toBe('curl');
    expect(detectFormat(fixture('import/curl-post.sh'))).toBe('curl');
    expect(detectFormat('please run curl later')).toBeNull();
    expect(detectFormat('{"item": []}')).toBeNull();
    expect(detectFormat('')).toBeNull();
  });
});

describe('importAny', () => {
  it('imports Postman with examples, path vars and request-level scripts', () => {
    const out = importAny(fixture('postman/collection-with-events.json'));

    expect(out.format).toBe('postman');
    expect(out.collections).toHaveLength(1);
    expect(out.environments).toEqual([]);

    const collection = out.collections[0];
    expectTreeShape(collection);

    const request = collection.items[0];
    expect(request.method).toBe('POST');
    expect(request.preRequest).toContain("pm.environment.set('userId'");
    expect(request.tests).toContain('pm.response.to.have.status(201)');
    expect(request.examples).toHaveLength(1);
    expect(request.pathVars).toEqual([{ key: 'id', value: '42' }]);
    expect(request.body.mode).toBe('form-data');
    expect(request.body.form.some((f) => f.type === 'file')).toBe(true);
  });

  it('imports OpenAPI and Swagger', () => {
    const openapi = importAny(fixture('import/petstore-openapi.json'));
    expect(openapi.format).toBe('openapi');
    expectTreeShape(openapi.collections[0]);
    expect(openapi.collections[0].items.length).toBeGreaterThan(0);

    const swagger = importAny(fixture('import/petstore-swagger2.json'));
    expect(swagger.format).toBe('swagger2');
    expectTreeShape(swagger.collections[0]);
  });

  it('imports HAR entries', () => {
    const out = importAny(fixture('import/sample.har'));
    expect(out.format).toBe('har');
    expectTreeShape(out.collections[0]);
  });

  it('wraps a cURL command in a single-request collection', () => {
    const out = importAny(fixture('import/curl-get-auth.sh'));
    expect(out.format).toBe('curl');
    const collection = out.collections[0];
    expectTreeShape(collection);
    expect(collection.items).toHaveLength(1);
    expect(collection.items[0].auth.type).toBe('basic');
  });

  it('imports Insomnia collections and environments together', () => {
    const out = importAny(fixture('import/insomnia-v4.json'));
    expect(out.format).toBe('insomnia');
    expect(out.collections).toHaveLength(1);
    expect(out.environments).toHaveLength(1);
    expect(out.environments[0].variables.length).toBe(2);
    expectTreeShape(out.collections[0]);
  });

  it('rejects unknown input with an actionable message', () => {
    expect(() => importAny('just some text')).toThrow(/Unrecognized format/);
    expect(() => importAs('bogus', '{}')).toThrow(/Unsupported import format/);
  });
});
