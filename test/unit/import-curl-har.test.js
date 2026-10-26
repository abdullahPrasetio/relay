import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { fromCurl } from '../../src/lib/import/curl.js';
import { fromHar } from '../../src/lib/import/har.js';
import { normalizeCollection } from '../../src/lib/collectionTree.js';

const fixture = (name) => readFileSync(new URL(`../fixtures/import/${name}`, import.meta.url), 'utf8');

function flattenRequests(node, out = []) {
  for (const item of node.items || []) {
    if (item.type === 'folder') flattenRequests(item, out);
    else out.push(item);
  }
  return out;
}

const headerValue = (request, key) => {
  const lower = key.toLowerCase();
  const found = (request.headers || []).find((h) => h.key.toLowerCase() === lower);
  return found ? found.value : undefined;
};

describe('fromCurl', () => {
  const curlPost = fromCurl(fixture('curl-post.sh'));

  it('reads method, url, headers and JSON body from a multi-line command', () => {
    expect(curlPost.method).toBe('POST');
    expect(curlPost.url).toBe('https://api.example.com/v1/items');
    expect(curlPost.headers).toHaveLength(2);
    expect(headerValue(curlPost, 'Content-Type')).toBe('application/json');
    expect(headerValue(curlPost, 'Accept')).toBe('application/json');
    expect(curlPost.body.mode).toBe('json');
    expect(JSON.parse(curlPost.body.raw)).toEqual({ name: 'Ada', role: 'engineer' });
  });

  it('reads basic auth, quoted headers, query and multipart form rows', () => {
    const request = fromCurl(fixture('curl-get-auth.sh'));

    expect(request.auth.type).toBe('basic');
    expect(request.auth.basic).toEqual({ username: 'user', password: 'pass' });
    expect(headerValue(request, 'Accept')).toBe('application/json');
    expect(headerValue(request, 'X-Note')).toBe("it's a test");
    expect(request.url).toBe('https://api.example.com/v1/items?x=1');
    expect(request.method).toBe('POST');
    expect(request.body.mode).toBe('form-data');

    const file = request.body.form.find((row) => row.key === 'file');
    expect(file).toMatchObject({
      type: 'file',
      filePath: '/tmp/report.pdf',
      fileName: 'report.pdf',
      contentType: 'application/pdf',
    });
    expect(file.filePath.endsWith('/tmp/report.pdf')).toBe(true);

    const text = request.body.form.find((row) => row.key === 'name');
    expect(text).toMatchObject({ key: 'name', value: 'Ada' });
    expect(text.type).toBeUndefined();
  });

  it('moves -d data into query params with -G', () => {
    const request = fromCurl("curl -G -d 'a=1&b=two%20words' https://api.example.com/search");

    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://api.example.com/search');
    expect(request.params).toEqual([
      { key: 'a', value: '1', enabled: true },
      { key: 'b', value: 'two words', enabled: true },
    ]);
    expect(request.body.mode).toBe('none');
  });

  it('defaults to POST when data is present and --json implies POST', () => {
    expect(fromCurl("curl -d 'a=1' https://api.example.com/x").method).toBe('POST');

    const json = fromCurl("curl --json '{\"a\":1}' https://api.example.com/x");
    expect(json.method).toBe('POST');
    expect(json.body.mode).toBe('json');
    expect(headerValue(json, 'Content-Type')).toBe('application/json');
  });

  it('throws when the command has no URL', () => {
    expect(() => fromCurl("curl -X POST -d 'a=1'")).toThrow('No URL found in cURL command');
  });
});

describe('fromHar', () => {
  const har = JSON.parse(fixture('sample.har'));
  const { collection } = fromHar(har);
  const requests = flattenRequests(collection);

  it('converts every valid entry and skips entries without a url', () => {
    expect(requests).toHaveLength(3);
    expect(requests.every((r) => typeof r.url === 'string' && r.url.startsWith('https://'))).toBe(true);
    expect(requests.some((r) => !r.url)).toBe(false);
  });

  it('groups entries into one folder per host', () => {
    expect(collection.items).toHaveLength(2);
    const names = collection.items.map((item) => item.name);
    expect(names).toEqual(['api.example.com', 'cdn.example.com']);
    expect(collection.items.every((item) => item.type === 'folder')).toBe(true);

    const api = collection.items[0];
    expect(api.items).toHaveLength(2);
    expect(api.items[0].name).toBe('GET /v1/items');
    expect(api.items[1].name).toBe('POST /v1/items');
  });

  it('names the collection from the HAR creator and first host', () => {
    expect(collection.name).toBe('Imported HAR (api.example.com)');
  });

  it('maps urlencoded and JSON bodies and drops pseudo/transport headers', () => {
    const post = requests.find((r) => r.method === 'POST');
    expect(post.body.mode).toBe('form-urlencoded');
    expect(post.body.form).toEqual([
      { key: 'name', value: 'Ada', enabled: true },
      { key: 'role', value: 'engineer', enabled: true },
    ]);
    expect(headerValue(post, 'Content-Type')).toBe('application/x-www-form-urlencoded');
    expect(headerValue(post, 'Cookie')).toBe('session=abc');

    const getJson = requests.find((r) => r.url.includes('limit=10'));
    expect(getJson.body.mode).toBe('none');
    expect(getJson.headers).toEqual([{ key: 'Accept', value: 'application/json', enabled: true }]);

    for (const request of requests) {
      for (const header of request.headers) {
        expect(header.key.startsWith(':')).toBe(false);
        expect(['host', 'content-length']).not.toContain(header.key.toLowerCase());
      }
    }
  });

  it('keeps the json body when the HAR records one', () => {
    const entries = [
      {
        request: {
          method: 'PUT',
          url: 'https://api.example.com/v1/items/1',
          headers: [{ name: 'Content-Type', value: 'application/json' }],
          postData: { mimeType: 'application/json', text: '{"name":"Ada"}' },
        },
      },
    ];
    const single = fromHar({ log: { entries } }).collection;

    // one host + one entry -> request at the collection root
    expect(single.items).toHaveLength(1);
    expect(single.items[0].type).toBe('request');
    expect(single.items[0].body.mode).toBe('json');
    expect(single.items[0].body.raw).toBe('{"name":"Ada"}');
  });

  it('passes through normalizeCollection without losing fields', () => {
    const normalized = normalizeCollection(collection);
    const normalizedRequests = flattenRequests(normalized);

    expect(normalized.name).toBe(collection.name);
    expect(normalized.items).toHaveLength(2);
    expect(normalizedRequests).toHaveLength(3);
    expect(normalizedRequests.map((r) => r.url)).toEqual(requests.map((r) => r.url));
    expect(normalizedRequests.map((r) => r.method)).toEqual(requests.map((r) => r.method));
    expect(normalizedRequests.every((r) => r.type === 'request')).toBe(true);

    const post = normalizedRequests.find((r) => r.method === 'POST');
    expect(post.body.mode).toBe('form-urlencoded');
    expect(post.body.form).toHaveLength(2);
    expect(headerValue(post, 'Cookie')).toBe('session=abc');
  });
});
