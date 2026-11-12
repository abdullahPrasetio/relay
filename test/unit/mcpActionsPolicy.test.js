import { describe, expect, it } from 'vitest';
import { createMcpActions } from '../../src/lib/mcpActions.js';

function makeStore(workspace) {
  return {
    activeWorkspace: workspace,
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
    collections: workspace.collections,
    environments: workspace.environments,
    globals: workspace.globals,
    history: [],
    historyLimit: 100,
  };
}

function makeWorkspace() {
  return {
    id: 'ws_policy',
    name: 'Policy',
    activeEnvId: null,
    mcpAccess: { allowSensitive: false },
    environments: [],
    globals: [],
    history: [],
    collections: [
      {
        id: 'col_policy',
        name: 'Policy collection',
        variables: [
          { key: 'TOKEN', value: 'top-secret', type: 'secret', enabled: true },
        ],
        items: [],
      },
    ],
  };
}

describe('MCP action sensitivity policy', () => {
  it('redacts collection secrets by default', async () => {
    const workspace = makeWorkspace();
    const actions = createMcpActions({
      store: makeStore(workspace),
      cloud: null,
      appearance: null,
      windowApi: {},
    });
    const out = await actions.invoke({
      tool: 'relay_collections',
      action: 'get',
      params: { collectionId: 'col_policy' },
    });
    expect(out.ok).toBe(true);
    expect(JSON.stringify(out.data)).not.toContain('top-secret');
    expect(out.data.variables[0]).toMatchObject({ key: 'TOKEN', hasValue: true });
  });

  it('returns plaintext only after the workspace opts in', async () => {
    const workspace = makeWorkspace();
    workspace.mcpAccess.allowSensitive = true;
    const actions = createMcpActions({
      store: makeStore(workspace),
      cloud: null,
      appearance: null,
      windowApi: {},
    });
    const out = await actions.invoke({
      tool: 'relay_collections',
      action: 'get',
      params: { collectionId: 'col_policy' },
    });
    expect(out.ok).toBe(true);
    expect(out.data.variables[0].value).toBe('top-secret');
  });
});
