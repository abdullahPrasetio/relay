import { describe, expect, it } from 'vitest';
import { convertScript, rowsToWorkspaces } from '../../cli/lib/wapbolt.mjs';
import { filesToWorkspace, workspaceToFiles } from '../../src/lib/gitWorkspace.js';

function sampleRows() {
  return {
    teams: [
      { id: 2, name: 'Backend Team' },
      { id: 3, name: 'QA' },
      { id: 4, name: 'Empty Team' },
    ],
    collections: [
      {
        id: 10,
        name: 'Payment API',
        description: 'Payment endpoints',
        team_id: 2,
        auth_config: '{"type":"Bearer Token","token":"{{token}}"}',
        pre_request_script: 'console.log("collection")',
        post_request_script: '',
        variables: '{"baseUrl":"https://api.example.com"}',
        chaos_mode: 1,
      },
      {
        id: 11,
        name: 'Archived',
        description: '',
        team_id: 2,
        auth_config: '{}',
        pre_request_script: '',
        post_request_script: '',
        variables: '{}',
      },
      {
        id: 12,
        name: 'QA API',
        description: '',
        team_id: 3,
        auth_config: '{}',
        pre_request_script: '',
        post_request_script: '',
        variables: '{}',
      },
    ],
    folders: [
      { id: 100, name: 'Users', collection_id: 10, parent_folder_id: null, order_index: 1 },
      { id: 101, name: 'Admin', collection_id: 10, parent_folder_id: 100, order_index: 1 },
      { id: 102, name: 'Deleted', collection_id: 10, parent_folder_id: null, order_index: 2 },
      { id: 103, name: 'QA folder', collection_id: 12, parent_folder_id: null, order_index: 1 },
    ],
    requests: [
      {
        id: 500,
        name: 'Create user',
        description: 'Creates a user',
        method: 'post',
        url: 'https://api.example.com/users?dryRun=true&q=a%20b#top',
        headers: '{"Content-Type":"application/json","X-Debug":"yes"}',
        body: '{"name":"Ada"}',
        body_type: 'raw-json',
        body_variants: '{"raw":"old body"}',
        auth_config: '{"type":"Basic Auth","username":"ada","password":"secret"}',
        field_validations: '{"body":{"name":{"rules":["required"],"min":1,"max":20}}}',
        extraction_rules: '[{"name":"id"}]',
        schema_assertions: '[]',
        collection_id: 10,
        folder_id: 100,
        order_index: 2,
        pre_request_script: 'pm.variables.set("x", "1")',
        post_request_script: 'pm.test("ok", () => {})',
      },
      {
        id: 501,
        name: 'Get user',
        description: '',
        method: 'GET',
        url: 'https://api.example.com/users/1',
        headers: '{}',
        body: '{}',
        body_type: 'none',
        body_variants: '{}',
        auth_config: '{"type":"Bearer Token","token":"abc"}',
        field_validations: '{}',
        extraction_rules: '[]',
        schema_assertions: '[]',
        collection_id: 10,
        folder_id: 101,
        order_index: 1,
        pre_request_script: "wap.environment.set('token', 'abc')",
        post_request_script: '',
      },
      {
        id: 502,
        name: 'Form request',
        description: '',
        method: 'POST',
        url: 'https://api.example.com/form',
        headers: '{}',
        body: '{"array":[{"key":"a","value":"1","enabled":true},{"key":"b","value":"2","enabled":false}]}',
        body_type: 'x-www-form-urlencoded',
        body_variants: '{}',
        auth_config: '{"type":"API Key","key":"X-Key","value":"v","addTo":"query"}',
        field_validations: '{}',
        extraction_rules: '[]',
        schema_assertions: '[]',
        collection_id: 10,
        folder_id: null,
        order_index: 0,
        pre_request_script: '',
        post_request_script: '',
      },
      {
        id: 503,
        name: 'Deleted request',
        description: '',
        method: 'GET',
        url: 'https://api.example.com/deleted',
        headers: '{}',
        body: '{}',
        body_type: 'none',
        body_variants: '{}',
        auth_config: '{}',
        field_validations: '{}',
        extraction_rules: '[]',
        schema_assertions: '[]',
        collection_id: 10,
        folder_id: null,
        order_index: 1,
        pre_request_script: '',
        post_request_script: '',
      },
      {
        id: 504,
        name: 'QA request',
        description: '',
        method: 'GET',
        url: 'https://qa.example.com/health',
        headers: '{}',
        body: '{}',
        body_type: 'none',
        body_variants: '{}',
        auth_config: '{"type":"Inherit"}',
        field_validations: '{}',
        extraction_rules: '[]',
        schema_assertions: '[]',
        collection_id: 12,
        folder_id: 103,
        order_index: 1,
        pre_request_script: '',
        post_request_script: '',
      },
      {
        id: 505,
        name: 'Orphan in deleted folder',
        description: '',
        method: 'GET',
        url: 'https://api.example.com/orphan',
        headers: '{}',
        body: '{}',
        body_type: 'none',
        body_variants: '{}',
        auth_config: '{}',
        field_validations: '{}',
        extraction_rules: '[]',
        schema_assertions: '[]',
        collection_id: 10,
        folder_id: 102,
        order_index: 0,
        pre_request_script: '',
        post_request_script: '',
      },
    ],
    request_examples: [
      {
        id: 900,
        request_id: 500,
        name: 'Created',
        request_method: 'POST',
        request_url: 'https://api.example.com/users',
        request_headers: '{"Content-Type":"application/json"}',
        request_body: '{"raw":"{\\"name\\":\\"Ada\\"}"}',
        response_status: 201,
        response_headers: '{"content-type":["application/json"],"x-a":["1","2"]}',
        response_body: '{"ok":true}',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
      },
      {
        id: 901,
        request_id: 503,
        name: 'Deleted example',
        request_method: 'GET',
        request_url: 'https://api.example.com/deleted',
        request_headers: '{}',
        request_body: '{}',
        response_status: 200,
        response_headers: '{}',
        response_body: '',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    environments: [
      {
        id: 20,
        name: 'Staging',
        variables: '{"baseUrl":"https://staging.example.com","token":"abc"}',
        team_id: 2,
        is_global: 0,
      },
      {
        id: 21,
        name: 'QA env',
        variables: '{"baseUrl":"https://qa.example.com"}',
        team_id: 3,
        is_global: 0,
      },
      {
        id: 22,
        name: 'Global',
        variables: '{"trace":"on"}',
        team_id: 2,
        is_global: 1,
      },
    ],
    sync_meta: [
      { entity: 'collection', local_id: 11, deleted_at: '2026-01-01T00:00:00.000Z' },
      { entity: 'folder', local_id: 102, deleted_at: '2026-01-01T00:00:00.000Z' },
      { entity: 'request', local_id: 503, deleted_at: '2026-01-01T00:00:00.000Z' },
      { entity: 'example', local_id: 901, deleted_at: '2026-01-01T00:00:00.000Z' },
    ],
  };
}

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

describe('rowsToWorkspaces (Wapbolt migration)', () => {
  const { workspaces, warnings } = rowsToWorkspaces(sampleRows());
  const backend = workspaces.find((entry) => entry.workspace.name === 'Backend Team').workspace;
  const qa = workspaces.find((entry) => entry.workspace.name === 'QA').workspace;

  it('creates one workspace per team with content and skips empty teams', () => {
    expect(workspaces.map((entry) => entry.workspace.name)).toEqual(['Backend Team', 'QA']);
    expect(backend.collections.map((collection) => collection.name)).toEqual(['Payment API']);
    expect(qa.collections.map((collection) => collection.name)).toEqual(['QA API']);
  });

  it('drops tombstoned collections, folders and requests', () => {
    const payment = backend.collections[0];
    expect(payment.items.some((item) => item.name === 'Archived')).toBe(false);
    expect(payment.items.some((item) => item.name === 'Deleted')).toBe(false);
    expect(requestsOf(payment).some((request) => request.name === 'Deleted request')).toBe(false);
  });

  it('reattaches requests whose folder was deleted to the collection root', () => {
    const payment = backend.collections[0];
    expect(payment.items.map((item) => item.name)).toEqual([
      'Users',
      'Form request',
      'Orphan in deleted folder',
    ]);
  });

  it('keeps the folder hierarchy and orders folders before requests', () => {
    const payment = backend.collections[0];
    const users = payment.items.find((item) => item.name === 'Users');
    expect(users.type).toBe('folder');
    expect(users.items.map((item) => item.name)).toEqual(['Admin', 'Create user']);
    expect(users.items[0].items.map((item) => item.name)).toEqual(['Get user']);
  });

  it('maps collection metadata, variables, auth and scripts', () => {
    const payment = backend.collections[0];
    expect(payment.description).toBe('Payment endpoints');
    expect(payment.variables).toEqual([
      { key: 'baseUrl', value: 'https://api.example.com', enabled: true, type: 'default' },
    ]);
    expect(payment.auth).toMatchObject({ type: 'bearer', bearer: { token: '{{token}}' } });
    expect(payment.preRequest).toBe('console.log("collection")');
    expect(payment.scriptsTrusted).toBe(false);
  });

  it('maps URL, params, headers, body, auth, scripts and validations', () => {
    const request = requestNamed(backend.collections[0], 'Create user');
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://api.example.com/users#top');
    expect(request.params).toEqual([
      { key: 'dryRun', value: 'true', enabled: true },
      { key: 'q', value: 'a b', enabled: true },
    ]);
    expect(request.headers).toEqual([
      { key: 'Content-Type', value: 'application/json', enabled: true },
      { key: 'X-Debug', value: 'yes', enabled: true },
    ]);
    expect(request.body.mode).toBe('json');
    expect(JSON.parse(request.body.raw)).toEqual({ name: 'Ada' });
    expect(request.auth).toMatchObject({
      type: 'basic',
      basic: { username: 'ada', password: 'secret' },
    });
    expect(request.preRequest).toBe('pm.variables.set("x", "1")');
    expect(request.tests).toBe('pm.test("ok", () => {})');
    expect(request.fieldValidations.body.name).toMatchObject({
      rules: ['required'],
      min: 1,
      max: 20,
    });
  });

  it('maps form bodies and API-key auth', () => {
    const request = requestNamed(backend.collections[0], 'Form request');
    expect(request.body.mode).toBe('form-urlencoded');
    expect(request.body.form).toEqual([
      { key: 'a', value: '1', type: 'text', enabled: true },
      { key: 'b', value: '2', type: 'text', enabled: false },
    ]);
    expect(request.auth).toMatchObject({
      type: 'apikey',
      apikey: { key: 'X-Key', value: 'v', addTo: 'query' },
    });
  });

  it('rewrites Wapbolt script API to Relay pm API', () => {
    expect(convertScript("wap.environment.set('a', 'b')")).toBe("pm.environment.set('a', 'b')");
    expect(convertScript('wap.response.status')).toBe('pm.response.code');
    expect(convertScript('wap.response.data')).toBe('pm.response.json()');
    expect(convertScript('wap.request.body')).toBe('pm.request.body.raw');
    expect(convertScript("wap.setEnv('x', 'y')")).toBe("pm.environment.set('x', 'y')");
    expect(convertScript("wap.test('ok', () => {})")).toBe("pm.test('ok', () => {})");
    expect(
      convertScript("wap.request.headers['Authorization'] = 'Bearer ' + wap.environment.get('token')")
    ).toBe(
      "pm.request.headers.upsert({ key: 'Authorization', value: 'Bearer ' + pm.environment.get('token') })"
    );
    expect(convertScript('const x = 1')).toBe('const x = 1');
  });

  it('maps inherited request auth', () => {
    const request = requestNamed(qa.collections[0], 'QA request');
    expect(request.auth.type).toBe('inherit');
  });

  it('converts Wapify scripts while importing them', () => {
    const request = requestNamed(backend.collections[0], 'Get user');
    expect(request.preRequest).toBe("pm.environment.set('token', 'abc')");
  });

  it('maps saved examples, flattening repeated response headers', () => {
    const request = requestNamed(backend.collections[0], 'Create user');
    expect(request.examples).toHaveLength(1);
    const example = request.examples[0];
    expect(example.name).toBe('Created');
    expect(example.savedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(example.request).toMatchObject({
      method: 'POST',
      url: 'https://api.example.com/users',
      headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
    });
    expect(example.request.body.mode).toBe('json');
    expect(JSON.parse(example.request.body.raw)).toEqual({ name: 'Ada' });
    expect(example.response.status).toBe(201);
    expect(example.response.contentType).toBe('application/json');
    expect(example.response.headers).toEqual([
      { key: 'content-type', value: 'application/json', enabled: true },
      { key: 'x-a', value: '1', enabled: true },
      { key: 'x-a', value: '2', enabled: true },
    ]);
    expect(example.response.body).toBe('{"ok":true}');
  });

  it('maps team environments and shared globals', () => {
    expect(backend.environments).toEqual([
      {
        id: 'env_wap_20',
        name: 'Staging',
        variables: [
          { key: 'baseUrl', value: 'https://staging.example.com', enabled: true, type: 'default' },
          { key: 'token', value: 'abc', enabled: true, type: 'default' },
        ],
      },
    ]);
    expect(qa.environments[0].name).toBe('QA env');
    expect(backend.globals).toEqual([
      { key: 'trace', value: 'on', enabled: true, type: 'default' },
    ]);
    expect(qa.globals).toEqual(backend.globals);
  });

  it('reports unsupported Wapbolt features instead of dropping them silently', () => {
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/alternate body variants/),
        expect.stringMatching(/extraction rules/),
        expect.stringMatching(/mock chaos/),
        expect.stringMatching(/wap\.\* API/),
      ])
    );
  });

  it('produces files Relay can import back into a workspace', () => {
    const files = workspaceToFiles(backend, { generatedAt: '2026-01-01T00:00:00.000Z' });
    const { workspace, warnings: importWarnings } = filesToWorkspace(files);
    expect(importWarnings).toEqual([]);
    expect(workspace.name).toBe('Backend Team');
    expect(workspace.collections).toHaveLength(1);
    expect(requestsOf(workspace.collections[0])).toHaveLength(4);
    expect(workspace.environments).toHaveLength(1);
    expect(workspace.globals).toHaveLength(1);

    const request = requestNamed(workspace.collections[0], 'Create user');
    expect(request.url).toBe('https://api.example.com/users#top');
    expect(request.params).toHaveLength(2);
    expect(request.auth.type).toBe('basic');
    expect(request.examples[0].response.headers).toHaveLength(3);
  });
});
