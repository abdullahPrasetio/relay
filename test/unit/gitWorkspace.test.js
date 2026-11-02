import { describe, expect, it } from 'vitest';
import {
  fileManifest,
  filesToWorkspace,
  FORMAT,
  slugify,
  VERSION,
  workspaceToFiles,
} from '../../src/lib/gitWorkspace.js';
import { newAuth, newRequest, newRequestSettings } from '../../src/lib/factory.js';
import { normalizeCollection } from '../../src/lib/collectionTree.js';
import { migrateToWorkspaces } from '../../src/lib/workspace.js';

const GENERATED_AT = '2024-05-01T00:00:00.000Z';
const SECRETS = ['s3cret', 'envsecret', 'globalsecret', 'ENCRYPTED_SECRET_BLOB', 'ENV_BLOB', 'GLOBAL_BLOB'];

const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

function buildWorkspace() {
  const request = {
    ...newRequest({
      name: 'Create user',
      method: 'POST',
      url: 'https://api.example.com/users/:id',
    }),
    id: 'req_abc',
    params: [{ key: 'dryRun', value: 'true', enabled: true }],
    headers: [{ key: 'X-Test', value: 'yes', enabled: true }],
    pathVars: [{ key: 'id', value: '42', enabled: true }],
    preRequest: 'console.log("before")',
    tests: 'pm.test("ok", () => {})',
    settings: { ...newRequestSettings(), timeoutMs: 1234 },
  };
  request.examples = [
    {
      id: 'ex_1',
      name: 'Example',
      savedAt: '2024-01-01T00:00:00.000Z',
      request: { id: 'req_abc', method: 'POST', url: 'https://api.example.com/users/42' },
      response: { status: 201 },
    },
  ];

  const users = normalizeCollection({
    id: 'col_users',
    name: 'User API',
    description: 'User endpoints',
    variables: [
      { key: 'baseUrl', value: 'https://api.example.com', enabled: true, type: 'default' },
      {
        key: 'token',
        value: 's3cret',
        enabled: true,
        type: 'secret',
        secretEnc: 'ENCRYPTED_SECRET_BLOB',
      },
    ],
    auth: { ...newAuth(), type: 'none' },
    items: [
      {
        id: 'fld_1',
        type: 'folder',
        name: 'Admin',
        description: '',
        auth: null,
        preRequest: '',
        tests: '',
        items: [request],
      },
      {
        ...newRequest({ name: 'Health', method: 'GET', url: 'https://api.example.com/health' }),
        id: 'req_top',
        type: 'request',
      },
    ],
  });

  const health = normalizeCollection({
    id: 'col_health',
    name: 'Health',
    description: '',
    variables: [],
    items: [
      {
        ...newRequest({ name: 'Ping', method: 'GET', url: 'https://api.example.com/ping' }),
        id: 'req_health',
        type: 'request',
      },
    ],
  });

  const raw = {
    id: 'ws_demo',
    name: 'Demo API',
    collections: [users, health],
    environments: [
      {
        id: 'env_prod',
        name: 'Prod',
        variables: [
          { key: 'baseUrl', value: 'https://prod.example.com', enabled: true, type: 'default' },
          {
            key: 'apiKey',
            value: 'envsecret',
            enabled: true,
            type: 'secret',
            secretEnc: 'ENV_BLOB',
          },
        ],
      },
    ],
    globals: [
      { key: 'trace', value: 'on', enabled: true, type: 'default' },
      { key: 'globalToken', value: 'globalsecret', enabled: true, type: 'secret', secretEnc: 'GLOBAL_BLOB' },
    ],
    history: [{ id: 'h1', method: 'GET', url: 'https://api.example.com' }],
    activeEnvId: 'env_prod',
  };

  // Canonicalize exactly like the store does on load.
  return migrateToWorkspaces({ workspaces: [raw] }).workspaces[0];
}

const exportFiles = (workspace = buildWorkspace()) =>
  workspaceToFiles(workspace, { generatedAt: GENERATED_AT });

describe('slugify', () => {
  it('lowercases, collapses non-alphanumerics, and trims dashes', () => {
    expect(slugify('My Great API!')).toBe('my-great-api');
    expect(slugify('  --Hello__World--  ')).toBe('hello-world');
    expect(slugify('a/b.c')).toBe('a-b-c');
  });

  it('falls back to "item" for empty or non-ASCII names', () => {
    expect(slugify('')).toBe('item');
    expect(slugify(null)).toBe('item');
    expect(slugify('日本語')).toBe('item');
    expect(slugify('---')).toBe('item');
  });
});

describe('workspaceToFiles', () => {
  it('writes a manifest plus one file per collection and environment', () => {
    const files = exportFiles();
    expect(Object.keys(files)).toEqual([
      'relay-workspace.json',
      'collections/user-api-col_users.json',
      'collections/health-col_health.json',
      'environments/prod-env_prod.json',
      'globals.json',
    ]);

    const manifest = JSON.parse(files['relay-workspace.json']);
    expect(manifest.format).toBe(FORMAT);
    expect(manifest.version).toBe(VERSION);
    expect(manifest.id).toBe('ws_demo');
    expect(manifest.name).toBe('Demo API');
    expect(manifest.activeEnvId).toBe('env_prod');
    expect(manifest.generatedAt).toBe(GENERATED_AT);
    expect(manifest.counts).toEqual({ collections: 2, requests: 3, environments: 1 });
    expect(manifest.collections).toEqual([
      { file: 'collections/user-api-col_users.json', id: 'col_users', name: 'User API' },
      { file: 'collections/health-col_health.json', id: 'col_health', name: 'Health' },
    ]);
    expect(manifest.environments).toEqual([
      { file: 'environments/prod-env_prod.json', id: 'env_prod', name: 'Prod' },
    ]);
  });

  it('exports Confluence page metadata without credentials', () => {
    const workspace = buildWorkspace();
    workspace.collections[0].confluencePageId = '123';
    workspace.collections[0].confluencePageUrl = 'https://org.test/wiki/pages/123';
    workspace.collections[0].confluenceTitle = 'User API docs';
    workspace.collections[0].confluenceSpaceKey = 'DOCS';
    workspace.collections[0].confluenceParentPageId = '456';
    workspace.collections[0].confluenceSyncedAt = '2026-10-31T00:00:00.000Z';
    workspace.collections[0].confluenceVersion = 2;

    const files = exportFiles(workspace);
    const file = JSON.parse(files['collections/user-api-col_users.json']);
    expect(file).toMatchObject({
      confluencePageId: '123',
      confluencePageUrl: 'https://org.test/wiki/pages/123',
      confluenceTitle: 'User API docs',
      confluenceSpaceKey: 'DOCS',
      confluenceParentPageId: '456',
      confluenceSyncedAt: '2026-10-31T00:00:00.000Z',
      confluenceVersion: 2,
    });
    expect(JSON.stringify(file)).not.toMatch(/tokenEnc|confluencePat|confluenceToken/i);

    const { workspace: restored } = filesToWorkspace(files);
    expect(restored.collections[0]).toMatchObject({
      confluencePageId: '123',
      confluencePageUrl: 'https://org.test/wiki/pages/123',
      confluenceTitle: 'User API docs',
      confluenceSpaceKey: 'DOCS',
      confluenceParentPageId: '456',
      confluenceSyncedAt: '2026-10-31T00:00:00.000Z',
      confluenceVersion: 2,
    });
  });

  it('round-trips mock scenarios through Git files', () => {
    const original = buildWorkspace();
    const sourceRequest = original.collections[0].items[0].items[0];
    sourceRequest.mock = {
      enabled: true,
      mode: 'manual',
      activeScenarioId: 'scn_1',
      scenarios: [
        {
          id: 'scn_1',
          name: 'Success',
          status: 201,
          contentType: 'application/json',
          body: '{"ok":true}',
          conditions: [{ source: 'query', key: 'state', operator: 'equals', value: 'ok' }],
        },
      ],
    };
    const { workspace, warnings } = filesToWorkspace(exportFiles(original));
    expect(warnings).toEqual([]);
    const restoredRequest = workspace.collections[0].items[0].items[0];
    expect(restoredRequest.mock).toMatchObject({
      mode: 'manual',
      activeScenarioId: 'scn_1',
    });
    expect(restoredRequest.mock.scenarios[0]).toMatchObject({
      id: 'scn_1',
      status: 201,
      conditions: [{ source: 'query', key: 'state', operator: 'equals', value: 'ok' }],
    });
  });

  it('is deterministic with stable 2-space JSON and trailing newlines', () => {
    const first = exportFiles();
    const second = exportFiles();

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    for (const content of Object.values(first)) {
      expect(content.startsWith('{\n  "format": "relay-workspace",')).toBe(true);
      expect(content.endsWith('}\n')).toBe(true);
      expect(() => JSON.parse(content)).not.toThrow();
    }
  });

  it('omits transient request runtime fields', () => {
    const ws = buildWorkspace();
    ws.collections[0].items.push({
      ...newRequest({ name: 'Runtime', url: 'https://example.com' }),
      id: 'req_transient',
      type: 'request',
      sending: true,
      sendingId: 'abc',
      response: { ok: true },
      testResults: { ran: true },
    });

    const files = exportFiles(ws);
    const parsed = JSON.parse(files['collections/user-api-col_users.json']);
    const node = parsed.items.find((item) => item.id === 'req_transient');
    expect(node).toBeTruthy();
    expect(node).not.toHaveProperty('sending');
    expect(node).not.toHaveProperty('sendingId');
    expect(node).not.toHaveProperty('response');
    expect(node).not.toHaveProperty('testResults');
  });

  it('sanitizes secret rows in collections, environments, and globals', () => {
    const files = exportFiles();
    const joined = Object.values(files).join('\n');
    for (const secret of SECRETS) expect(joined).not.toContain(secret);

    const collection = JSON.parse(files['collections/user-api-col_users.json']);
    expect(collection.variables[1]).toEqual({ key: 'token', enabled: true, type: 'secret' });
    expect(collection.variables[1]).not.toHaveProperty('value');
    expect(collection.variables[1]).not.toHaveProperty('secretEnc');
    expect(collection.variables[0]).toEqual({
      key: 'baseUrl',
      value: 'https://api.example.com',
      enabled: true,
      type: 'default',
    });

    const environment = JSON.parse(files['environments/prod-env_prod.json']);
    expect(environment.variables[1]).toEqual({ key: 'apiKey', enabled: true, type: 'secret' });

    const globals = JSON.parse(files['globals.json']);
    expect(globals.variables[1]).toEqual({ key: 'globalToken', enabled: true, type: 'secret' });
  });
});

describe('filesToWorkspace', () => {
  it('round-trips names, ids, items, environments, and globals', () => {
    const original = buildWorkspace();
    const { workspace, warnings } = filesToWorkspace(exportFiles(original));

    expect(warnings).toEqual([]);
    expect(workspace.id).toBe(original.id);
    expect(workspace.name).toBe(original.name);
    expect(workspace.activeEnvId).toBe('env_prod');
    expect(workspace.history).toEqual([]);
    expect(workspace.collections.map((c) => c.name)).toEqual(['User API', 'Health']);
    expect(workspace.collections.map((c) => c.id)).toEqual(['col_users', 'col_health']);
    expect(workspace.collections[0].items).toEqual(original.collections[0].items);
    expect(workspace.collections[1].items).toEqual(original.collections[1].items);

    // Secret rows come back empty, never with plaintext or ciphertext.
    expect(workspace.collections[0].variables[1]).toEqual({
      key: 'token',
      value: '',
      enabled: true,
      type: 'secret',
    });
    expect(workspace.environments[0].id).toBe('env_prod');
    expect(workspace.environments[0].variables[0]).toEqual({
      key: 'baseUrl',
      value: 'https://prod.example.com',
      enabled: true,
      type: 'default',
    });
    expect(workspace.environments[0].variables[1]).toEqual({
      key: 'apiKey',
      value: '',
      enabled: true,
      type: 'secret',
    });
    expect(workspace.globals).toEqual([
      { key: 'trace', value: 'on', enabled: true, type: 'default' },
      { key: 'globalToken', value: '', enabled: true, type: 'secret' },
    ]);
  });

  it('rejects a missing or foreign manifest', () => {
    expect(() => filesToWorkspace({})).toThrow('Not a Relay workspace export');
    expect(() => filesToWorkspace({ 'relay-workspace.json': '{oops' })).toThrow(
      'Not a Relay workspace export'
    );
    expect(() =>
      filesToWorkspace({ 'relay-workspace.json': serialize({ format: 'other', version: 1 }) })
    ).toThrow('Not a Relay workspace export');
  });

  it('rejects unsupported versions with a version message', () => {
    const files = exportFiles();
    const manifest = JSON.parse(files['relay-workspace.json']);
    manifest.version = 2;
    files['relay-workspace.json'] = serialize(manifest);

    expect(() => filesToWorkspace(files)).toThrow(/version/i);
    expect(() => filesToWorkspace(files)).toThrow(/2/);
  });

  it('ignores traversal and unreferenced files and warns about missing ones', () => {
    const files = exportFiles();
    const manifest = JSON.parse(files['relay-workspace.json']);
    manifest.collections.push({ file: '../evil.json', id: 'col_evil', name: 'Evil' });
    files['relay-workspace.json'] = serialize(manifest);
    files['../evil.json'] = serialize({ format: FORMAT, id: 'col_evil', name: 'Evil', items: [] });
    files['extra.json'] = serialize({ format: FORMAT, variables: [] });
    delete files['collections/health-col_health.json'];

    const { workspace, warnings } = filesToWorkspace(files);

    expect(workspace.collections.map((c) => c.id)).toEqual(['col_users']);
    expect(warnings.some((w) => w.includes('../evil.json'))).toBe(true);
    expect(warnings.some((w) => w.includes('Missing file'))).toBe(true);
    expect(warnings.some((w) => w.includes('extra.json'))).toBe(false);
    expect(warnings.some((w) => w.includes('evil.json') && !w.includes('../'))).toBe(false);
  });

  it('remaps colliding workspace, collection, and nested item ids', () => {
    const { workspace, warnings } = filesToWorkspace(exportFiles(), {
      existingWorkspaceIds: ['ws_demo'],
      existingCollectionIds: ['col_users'],
    });

    expect(workspace.id).not.toBe('ws_demo');
    expect(workspace.name).toBe('Demo API');

    const users = workspace.collections.find((c) => c.name === 'User API');
    expect(users.id).not.toBe('col_users');
    expect(users.items[0].id).not.toBe('fld_1');
    expect(users.items[0].items[0].id).not.toBe('req_abc');
    expect(users.items[0].items[0].examples[0].id).not.toBe('ex_1');
    expect(users.items[0].items[0].name).toBe('Create user');
    expect(users.items[1].id).not.toBe('req_top');

    const health = workspace.collections.find((c) => c.name === 'Health');
    expect(health.id).toBe('col_health');
    expect(workspace.activeEnvId).toBe('env_prod');
    expect(warnings).toContain('ids remapped');
  });

  it('remaps environment ids on collision and keeps activeEnvId pointing at the new id', () => {
    const { workspace, warnings } = filesToWorkspace(exportFiles(), {
      existingCollectionIds: ['env_prod'],
    });

    expect(workspace.environments[0].id).not.toBe('env_prod');
    expect(workspace.activeEnvId).toBe(workspace.environments[0].id);
    expect(warnings).toContain('ids remapped');
  });

  it('drops an activeEnvId whose environment is missing', () => {
    const files = exportFiles();
    const manifest = JSON.parse(files['relay-workspace.json']);
    manifest.activeEnvId = 'env_gone';
    files['relay-workspace.json'] = serialize(manifest);

    const { workspace } = filesToWorkspace(files);
    expect(workspace.activeEnvId).toBeNull();
  });

  it('round-trips an empty workspace with only the manifest and globals', () => {
    const empty = migrateToWorkspaces({
      workspaces: [
        {
          id: 'ws_empty',
          name: 'Empty',
          collections: [],
          environments: [],
          globals: [],
          history: [],
          activeEnvId: null,
        },
      ],
    }).workspaces[0];

    const files = exportFiles(empty);
    expect(Object.keys(files)).toEqual(['relay-workspace.json', 'globals.json']);
    expect(JSON.parse(files['relay-workspace.json']).counts).toEqual({
      collections: 0,
      requests: 0,
      environments: 0,
    });

    const { workspace, warnings } = filesToWorkspace(files);
    expect(warnings).toEqual([]);
    expect(workspace.id).toBe('ws_empty');
    expect(workspace.name).toBe('Empty');
    expect(workspace.collections).toEqual([]);
    expect(workspace.environments).toEqual([]);
    expect(workspace.globals).toEqual([]);
    expect(workspace.history).toEqual([]);
    expect(workspace.activeEnvId).toBeNull();
  });
});

describe('fileManifest', () => {
  it('returns the parsed manifest for a valid map', () => {
    const manifest = fileManifest(exportFiles());
    expect(manifest.format).toBe(FORMAT);
    expect(manifest.version).toBe(VERSION);
  });

  it('throws for invalid input', () => {
    expect(() => fileManifest(null)).toThrow('Not a Relay workspace export');
    expect(() => fileManifest({ 'relay-workspace.json': '[]' })).toThrow(
      'Not a Relay workspace export'
    );
  });
});
