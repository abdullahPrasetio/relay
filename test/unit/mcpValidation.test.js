import { describe, expect, it } from 'vitest';
import { createMcpActions } from '../../src/lib/mcpActions.js';
import { validateAction } from '../../shared/mcpTools.js';

function makeWorkspace() {
  return {
    id: 'ws_validation',
    name: 'Validation',
    activeEnvId: null,
    mcpAccess: { allowSensitive: false },
    environments: [],
    globals: [],
    history: [],
    collections: [
      {
        id: 'col_validation',
        name: 'Validation collection',
        variables: [],
        items: [
          {
            id: 'req_validation',
            type: 'request',
            name: 'Create merchant',
            method: 'POST',
            url: 'https://api.test/merchants',
          },
        ],
      },
    ],
  };
}

function makeStore(workspace) {
  const store = {
    activeWorkspace: workspace,
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
    collections: workspace.collections,
    environments: workspace.environments,
    globals: workspace.globals,
    history: workspace.history,
    historyLimit: 100,
    setCollections(next) {
      workspace.collections = next;
      store.collections = next;
    },
    setEnvironments(next) {
      workspace.environments = next;
      store.environments = next;
    },
    setGlobals(next) {
      workspace.globals = next;
      store.globals = next;
    },
    setActiveEnvId(next) {
      workspace.activeEnvId = next;
    },
    setHistory(next) {
      workspace.history = next;
      store.history = next;
    },
    patchWorkspace(id, patch) {
      if (id === workspace.id) Object.assign(workspace, patch);
    },
  };
  return store;
}

describe('MCP request validation metadata', () => {
  it('accepts fieldValidations on create and returns them from get', async () => {
    const workspace = makeWorkspace();
    const actions = createMcpActions({
      store: makeStore(workspace),
      cloud: null,
      appearance: null,
      windowApi: {},
    });

    const created = await actions.invoke({
      tool: 'relay_requests',
      action: 'create',
      params: {
        collectionId: 'col_validation',
        request: {
          name: 'Validated request',
          method: 'POST',
          url: 'https://api.test/items',
          fieldValidations: {
            body: {
              id: { rules: ['required', 'integer'], min: 1, max: 10, description: 'ID' },
            },
          },
        },
      },
    });
    expect(created.ok).toBe(true);

    const fetched = await actions.invoke({
      tool: 'relay_requests',
      action: 'get',
      params: { requestId: created.data.requestId },
    });
    expect(fetched.ok).toBe(true);
    expect(fetched.data.request.fieldValidations.body.id).toMatchObject({
      rules: ['required', 'integer'],
      min: 1,
      max: 10,
      description: 'ID',
    });
  });

  it('replaces validation metadata through set_validation', async () => {
    const workspace = makeWorkspace();
    const actions = createMcpActions({
      store: makeStore(workspace),
      cloud: null,
      appearance: null,
      windowApi: {},
    });

    const result = await actions.invoke({
      tool: 'relay_requests',
      action: 'set_validation',
      params: {
        requestId: 'req_validation',
        fieldValidations: {
          params: {
            page: { rules: ['integer'], min: 1, max: 20, description: 'Page number' },
          },
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.data.fieldValidations.params.page).toMatchObject({
      rules: ['integer'],
      min: 1,
      max: 20,
    });

    const fetched = await actions.invoke({
      tool: 'relay_requests',
      action: 'get',
      params: { requestId: 'req_validation' },
    });
    expect(fetched.data.request.fieldValidations.params.page.description).toBe('Page number');
  });

  it('validates the set_validation MCP parameter shape', () => {
    expect(
      validateAction('relay_requests', 'set_validation', {
        requestId: 'req_1',
        fieldValidations: {},
      }).ok
    ).toBe(true);
    expect(
      validateAction('relay_requests', 'set_validation', { requestId: 'req_1' }).ok
    ).toBe(false);
  });
});
