import { describe, expect, it } from 'vitest';
import {
  applyRequestPatch,
  combinedPreRequest,
  combinedTests,
  effectiveAuth,
  withEffectiveAuth,
} from '../../packages/core/src/inheritance.js';
import { findNodePath } from '../../src/lib/collectionTree.js';

const request = {
  id: 'req_1',
  type: 'request',
  name: 'Request',
  auth: { type: 'inherit' },
  preRequest: 'req-pre',
  tests: 'req-test',
};

const innerFolder = {
  id: 'folder_inner',
  type: 'folder',
  name: 'Inner',
  auth: { type: 'basic', basic: { username: 'inner', password: 'pw' } },
  preRequest: 'inner-pre',
  tests: 'inner-test',
  items: [request],
};

const outerFolder = {
  id: 'folder_outer',
  type: 'folder',
  name: 'Outer',
  auth: { type: 'bearer', bearer: { token: 'outer-token' } },
  preRequest: 'outer-pre',
  tests: 'outer-test',
  items: [innerFolder],
};

const collection = {
  id: 'col_1',
  name: 'Collection',
  auth: { type: 'apikey', apikey: { key: 'k', value: 'v' } },
  preRequest: 'collection-pre',
  tests: 'collection-test',
  items: [outerFolder],
};

const collections = [collection];

function pathFor(id) {
  return findNodePath(collections, id);
}

describe('findNodePath', () => {
  it('returns the ancestor chain outermost first, without the request', () => {
    expect(pathFor('req_1')).toEqual([collection, outerFolder, innerFolder]);
  });

  it('includes the folder itself when asking for a folder', () => {
    expect(pathFor('folder_inner')).toEqual([collection, outerFolder, innerFolder]);
  });

  it('returns null for unknown nodes', () => {
    expect(pathFor('missing')).toBeNull();
  });
});

describe('effectiveAuth', () => {
  it('uses the nearest ancestor with a concrete auth type', () => {
    expect(effectiveAuth(request, pathFor('req_1'))).toEqual(innerFolder.auth);
  });

  it('falls through inherit ancestors to the next concrete auth', () => {
    const inheritingInner = { ...innerFolder, auth: { type: 'inherit' } };
    const req = { ...request };
    const chain = [collection, outerFolder, inheritingInner];
    expect(effectiveAuth(req, chain)).toEqual(outerFolder.auth);
  });

  it('falls through to the collection when all folders inherit', () => {
    const chain = [
      collection,
      { ...outerFolder, auth: { type: 'inherit' } },
      { ...innerFolder, auth: null },
    ];
    expect(effectiveAuth(request, chain)).toEqual(collection.auth);
  });

  it('returns none when nothing defines auth', () => {
    expect(effectiveAuth({ ...request, auth: { type: 'inherit' } }, [])).toEqual({ type: 'none' });
    expect(effectiveAuth({ auth: { type: 'inherit' } }, null)).toEqual({ type: 'none' });
  });

  it('prefers an explicit request auth over every ancestor', () => {
    const explicit = { ...request, auth: { type: 'jwt', jwt: { secret: 's' } } };
    expect(effectiveAuth(explicit, pathFor('req_1'))).toEqual(explicit.auth);
    expect(withEffectiveAuth(explicit, pathFor('req_1')).auth).toEqual(explicit.auth);
  });

  it('still accepts a single collection node (backwards compatible)', () => {
    expect(effectiveAuth(request, collection)).toEqual(collection.auth);
  });
});

describe('combined scripts', () => {
  it('runs collection, then folders outermost -> innermost, then request', () => {
    expect(combinedPreRequest(request, pathFor('req_1'))).toBe(
      'collection-pre\n;\nouter-pre\n;\ninner-pre\n;\nreq-pre'
    );
    expect(combinedTests(request, pathFor('req_1'))).toBe(
      'collection-test\n;\nouter-test\n;\ninner-test\n;\nreq-test'
    );
  });

  it('skips empty scripts at any level', () => {
    const req = { ...request, preRequest: '  ', tests: '' };
    const chain = [
      { ...collection, preRequest: '', tests: 'col-test' },
      { ...outerFolder, preRequest: 'outer-pre', tests: '' },
      { ...innerFolder, preRequest: '', tests: '' },
    ];
    expect(combinedPreRequest(req, chain)).toBe('outer-pre');
    expect(combinedTests(req, chain)).toBe('col-test');
  });

  it('supports the legacy single-collection signature', () => {
    expect(combinedPreRequest(request, collection)).toBe('collection-pre\n;\nreq-pre');
    expect(combinedTests(request, collection)).toBe('collection-test\n;\nreq-test');
  });

  it('returns only the request script when there is no collection', () => {
    expect(combinedPreRequest(request, null)).toBe('req-pre');
    expect(combinedTests(request, [])).toBe('req-test');
  });
});

describe('applyRequestPatch', () => {
  const patchable = {
    id: 'req_patch',
    method: 'GET',
    url: 'https://api.example.com/users/:id',
    params: [
      { key: 'page', value: '1', enabled: true },
      { key: 'off', value: 'x', enabled: false },
    ],
    pathVars: [
      { key: 'id', value: '42' },
      { key: 'gone', value: 'z' },
    ],
    headers: [{ key: 'Accept', value: '*/*', enabled: true }],
    body: { mode: 'raw', raw: 'old', form: [], graphql: { query: 'q', variables: '' } },
    auth: { type: 'none' },
  };

  it('returns the same request when the patch is empty', () => {
    expect(applyRequestPatch(patchable, {})).toBe(patchable);
    expect(applyRequestPatch(patchable, null)).toBe(patchable);
  });

  it('merges query param deltas by key and applies removedParams', () => {
    const next = applyRequestPatch(patchable, {
      params: [
        { key: 'page', value: '3', enabled: true },
        { key: 'sort', value: 'desc', enabled: true },
      ],
      removedParams: ['off'],
    });

    expect(next.params).toEqual([
      { key: 'page', value: '3', enabled: true },
      { key: 'sort', value: 'desc', enabled: true },
    ]);
  });

  it('compares param keys case-insensitively', () => {
    const next = applyRequestPatch(patchable, {
      params: [{ key: 'PAGE', value: '9' }],
    });

    expect(next.params[0]).toEqual({ key: 'PAGE', value: '9', enabled: true });
    // No duplicate was appended; the disabled param survived.
    expect(next.params).toHaveLength(2);
    expect(next.params[1]).toEqual({ key: 'off', value: 'x', enabled: false });
  });

  it('merges pathVars deltas and applies removedPathVars', () => {
    const next = applyRequestPatch(patchable, {
      pathVars: [
        { key: 'id', value: '7' },
        { key: 'slug', value: 'relay' },
      ],
      removedPathVars: ['gone'],
    });

    expect(next.pathVars).toEqual([
      { key: 'id', value: '7' },
      { key: 'slug', value: 'relay' },
    ]);
  });

  it('keeps the existing method/url/headers/body behavior', () => {
    const next = applyRequestPatch(patchable, {
      method: 'POST',
      url: 'https://changed.example/x',
      headers: [{ key: 'X-Debug', value: '1' }],
      body: { raw: 'new' },
    });

    expect(next.method).toBe('POST');
    expect(next.url).toBe('https://changed.example/x');
    expect(next.headers).toEqual([{ key: 'X-Debug', value: '1', enabled: true }]);
    // Body merges: untouched fields (mode/graphql) survive.
    expect(next.body).toEqual({
      mode: 'raw',
      raw: 'new',
      form: [],
      graphql: { query: 'q', variables: '' },
    });
  });

  it('never mutates the incoming request', () => {
    const snapshot = JSON.parse(JSON.stringify(patchable));
    applyRequestPatch(patchable, {
      method: 'DELETE',
      params: [{ key: 'new', value: '1', enabled: true }],
      removedParams: ['page'],
      pathVars: [{ key: 'id', value: '0' }],
    });
    expect(patchable).toEqual(snapshot);
  });
});
