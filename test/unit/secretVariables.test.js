import { describe, expect, it } from 'vitest';
import { normalizeCollection } from '../../src/lib/collectionTree.js';
import {
  fromPostmanEnvironment,
  toPostmanEnvironment,
} from '../../src/lib/environmentFormat.js';
import {
  fromPostmanCollection,
  fromPostmanGlobals,
  toPostmanCollection,
  toPostmanGlobals,
  toWorkspaceBackup,
} from '../../src/lib/postmanFormat.js';
import { maskSecrets, secretValues } from '../../src/lib/variables.js';
import { migrateToWorkspaces } from '../../src/lib/workspace.js';

const SECRET_ROW = {
  key: 'token',
  value: 's3cr3t-value',
  enabled: true,
  type: 'secret',
  secretEnc: 'ZW5jcnlwdGVk',
};

describe('variable type migration', () => {
  it('defaults missing types and preserves secret type, value, and secretEnc', () => {
    const data = {
      workspaces: [
        {
          id: 'ws_1',
          name: 'One',
          collections: [
            {
              id: 'col_1',
              name: 'Collection',
              variables: [
                { key: 'plain', value: 'v' },
                { key: 'disabled', value: 'd', enabled: false },
                SECRET_ROW,
              ],
              items: [],
            },
          ],
          environments: [
            {
              id: 'env_1',
              name: 'Dev',
              variables: [{ key: 'host', value: 'http://x' }, SECRET_ROW],
            },
          ],
          globals: [{ key: 'g', value: 'global' }],
          history: [],
          activeEnvId: 'env_1',
        },
      ],
      activeWorkspaceId: 'ws_1',
    };

    const ws = migrateToWorkspaces(data).workspaces[0];

    expect(ws.globals).toEqual([
      { key: 'g', value: 'global', enabled: true, type: 'default' },
    ]);

    expect(ws.environments[0].variables).toEqual([
      { key: 'host', value: 'http://x', enabled: true, type: 'default' },
      SECRET_ROW,
    ]);

    const rows = ws.collections[0].variables;
    expect(rows[0]).toEqual({ key: 'plain', value: 'v', enabled: true, type: 'default' });
    expect(rows[1]).toEqual({
      key: 'disabled',
      value: 'd',
      enabled: false,
      type: 'default',
    });
    expect(rows[2]).toEqual(SECRET_ROW);
  });

  it('normalizes collection variables through normalizeCollection', () => {
    const collection = normalizeCollection({
      id: 'col_x',
      name: 'X',
      variables: [
        { key: 'n', value: 42 },
        { key: 's', type: 'secret', secretEnc: 'abc=', value: '' },
        null,
      ],
      items: [],
    });
    expect(collection.variables).toEqual([
      { key: 'n', value: '42', enabled: true, type: 'default' },
      { key: 's', value: '', enabled: true, type: 'secret', secretEnc: 'abc=' },
    ]);
  });

  it('keeps secretEnc untouched when the row is already type secret', () => {
    const [row] = normalizeCollection({ variables: [SECRET_ROW] }).variables;
    expect(row.secretEnc).toBe('ZW5jcnlwdGVk');
    expect(row.value).toBe('s3cr3t-value');
  });
});

describe('secretValues and maskSecrets', () => {
  it('collects plaintext values of enabled or disabled secret rows', () => {
    const rows = [
      { key: 'a', value: 'alpha', type: 'secret' },
      { key: 'b', value: 'x', type: 'secret' }, // too short to mask safely
      { key: 'c', value: 'plain', type: 'default' },
      { key: 'd', value: 'beta', type: 'secret', enabled: false },
      null,
    ];
    expect(secretValues(rows)).toEqual(['alpha', 'beta']);
    expect(secretValues({ variables: rows })).toEqual(['alpha', 'beta']);
    expect(secretValues(undefined)).toEqual([]);
  });

  it('masks every secret occurrence', () => {
    expect(maskSecrets('alpha mid beta alpha', ['alpha', 'beta'])).toBe(
      '•••• mid •••• ••••'
    );
  });

  it('never masks one-character secrets', () => {
    expect(maskSecrets('a cat', ['a'])).toBe('a cat');
  });

  it('is a no-op for empty or non-string input and empty secrets', () => {
    expect(maskSecrets('', ['alpha'])).toBe('');
    expect(maskSecrets(null, ['alpha'])).toBeNull();
    expect(maskSecrets('text')).toBe('text');
    expect(maskSecrets('text', [null, '', 'z'])).toBe('text');
  });
});

describe('export masking', () => {
  const environment = {
    id: 'env_1',
    name: 'Dev',
    variables: [
      { key: 'host', value: 'http://x', enabled: true, type: 'default' },
      { ...SECRET_ROW },
    ],
  };

  it('masks secret values in Postman environment exports', () => {
    const exported = toPostmanEnvironment(environment);
    expect(exported.values).toEqual([
      { key: 'host', value: 'http://x', type: 'default', enabled: true },
      { key: 'token', value: '', type: 'secret', enabled: true },
    ]);
    expect(JSON.stringify(exported)).not.toContain('s3cr3t-value');
    expect(JSON.stringify(exported)).not.toContain('ZW5jcnlwdGVk');
  });

  it('restores type secret and an empty value when importing environments', () => {
    const imported = fromPostmanEnvironment(
      JSON.parse(JSON.stringify(toPostmanEnvironment(environment)))
    );
    expect(imported.variables[0]).toEqual({
      key: 'host',
      value: 'http://x',
      enabled: true,
    });
    expect(imported.variables[1]).toEqual({
      key: 'token',
      value: '',
      enabled: true,
      type: 'secret',
    });
  });

  it('masks secret values in Postman collection exports and restores the type', () => {
    const collection = {
      id: 'col_1',
      name: 'C',
      variables: [
        { key: 'baseUrl', value: 'http://x', enabled: true, type: 'default' },
        { key: 'token', value: 's3cr3t-value', enabled: false, type: 'secret' },
      ],
      items: [],
    };
    const exported = toPostmanCollection(collection);
    expect(exported.variable).toEqual([
      { key: 'baseUrl', value: 'http://x', disabled: false },
      { key: 'token', value: '', type: 'secret', disabled: true },
    ]);
    expect(JSON.stringify(exported)).not.toContain('s3cr3t-value');

    const imported = fromPostmanCollection(JSON.parse(JSON.stringify(exported)));
    expect(imported.variables[1]).toEqual({
      key: 'token',
      value: '',
      enabled: false,
      type: 'secret',
    });
    expect(imported.variables[0].type).toBeUndefined();
  });

  it('masks secret values in globals and workspace backups', () => {
    const globals = [
      { key: 'g', value: 'plain', enabled: true, type: 'default' },
      { key: 'token', value: 's3cr3t-value', enabled: true, type: 'secret' },
    ];
    const exported = toPostmanGlobals(globals);
    expect(exported.values[1]).toEqual({
      key: 'token',
      value: '',
      type: 'secret',
      enabled: true,
    });
    expect(JSON.stringify(exported)).not.toContain('s3cr3t-value');
    expect(fromPostmanGlobals(exported)[1]).toEqual({
      key: 'token',
      value: '',
      enabled: true,
      type: 'secret',
    });

    const backup = toWorkspaceBackup({
      name: 'W',
      collections: [],
      environments: [environment],
      globals,
    });
    expect(JSON.stringify(backup)).not.toContain('s3cr3t-value');
  });
});
