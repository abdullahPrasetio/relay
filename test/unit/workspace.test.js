import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateToWorkspaces, SCHEMA_VERSION } from '../../src/lib/workspace.js';

const fixture = (p) => readFileSync(path.join(import.meta.dirname, '..', 'fixtures', p), 'utf8');

describe('migrateToWorkspaces', () => {
  it('migrates legacy flat data into one workspace with a wrapped request', () => {
    const data = JSON.parse(fixture('data/legacy-flat.json'));
    const migrated = migrateToWorkspaces(data);

    expect(migrated.schemaVersion).toBe(3);
    expect(SCHEMA_VERSION).toBe(3);
    expect(migrated.workspaces).toHaveLength(1);

    const ws = migrated.workspaces[0];
    expect(migrated.activeWorkspaceId).toBe(ws.id);
    expect(ws.collections).toHaveLength(1);

    const collection = ws.collections[0];
    expect(collection.id).toBe('col_legacy');
    expect(collection.items).toHaveLength(1);

    const node = collection.items[0];
    expect(node.type).toBe('request');
    expect(node.id).toBe('req_legacy');
    expect(node.method).toBe('GET');
    expect(node.url).toBe('https://example.com');
  });

  it('stamps the schema version on already-workspace-shaped data', () => {
    const data = {
      workspaces: [
        { id: 'ws_1', name: 'One', collections: [], environments: [], globals: [], history: [] },
      ],
      activeWorkspaceId: 'ws_1',
    };
    const migrated = migrateToWorkspaces(data);
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
    expect(migrated.workspaces).toHaveLength(1);
    expect(migrated.activeWorkspaceId).toBe('ws_1');
  });
});
