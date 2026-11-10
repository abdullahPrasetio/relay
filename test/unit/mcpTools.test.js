import { describe, expect, it } from 'vitest';
import { MCP_SCOPES } from '../../shared/mcpScopes.js';
import {
  MCP_TOOLS,
  MCP_TOOL_NAMES,
  getActionSpec,
  helpPayload,
  summarizeAction,
  validateAction,
} from '../../shared/mcpTools.js';

const scopeSet = new Set(MCP_SCOPES);

describe('catalogue shape', () => {
  it('declares a scope for every action except relay_help', () => {
    for (const [toolName, tool] of Object.entries(MCP_TOOLS)) {
      expect(tool.name).toBe(toolName);
      expect(Object.keys(tool.actions).length).toBeGreaterThan(0);
      for (const [actionName, spec] of Object.entries(tool.actions)) {
        if (toolName === 'relay_help') {
          expect(spec.scope).toBeNull();
          expect(spec.approval).toBe(false);
          continue;
        }
        expect(scopeSet.has(spec.scope), `${toolName}.${actionName}`).toBe(true);
        // Approval is required for everything that is not a pure read.
        expect(spec.approval, `${toolName}.${actionName}`).toBe(spec.scope !== 'read');
        expect(typeof spec.description).toBe('string');
        expect(spec.params).toBeTypeOf('object');
      }
    }
  });

  it('exposes the catalogue through relay_help', () => {
    const help = helpPayload();
    expect(Object.keys(help.scopes)).toEqual(MCP_SCOPES);
    expect(help.tools).toBe(MCP_TOOLS);
    expect(MCP_TOOL_NAMES).toContain('relay_execute');
  });

  it('uses only declared param types', () => {
    const allowed = new Set(['string', 'number', 'boolean', 'object', 'array', 'string|null']);
    for (const tool of Object.values(MCP_TOOLS)) {
      for (const spec of Object.values(tool.actions)) {
        for (const def of Object.values(spec.params)) {
          expect(allowed.has(def.type)).toBe(true);
          expect(typeof def.required).toBe('boolean');
          expect(typeof def.description).toBe('string');
        }
      }
    }
  });
});

describe('getActionSpec', () => {
  it('returns the spec or null', () => {
    expect(getActionSpec('relay_execute', 'send').scope).toBe('request');
    expect(getActionSpec('relay_execute', 'nope')).toBeNull();
    expect(getActionSpec('nope', 'send')).toBeNull();
  });
});

describe('validateAction', () => {
  it('accepts a valid call and returns only declared params', () => {
    const result = validateAction('relay_collections', 'create', { name: 'AI Review', extra: 1 });
    // Unknown params are rejected rather than silently dropped.
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('invalid_params');

    const ok = validateAction('relay_collections', 'create', { name: 'AI Review' });
    expect(ok).toEqual({ ok: true, params: { name: 'AI Review' } });
  });

  it('rejects unknown tools and actions', () => {
    expect(validateAction('relay_nope', 'x').error.code).toBe('invalid_params');
    expect(validateAction('relay_app', 'nope').error.code).toBe('invalid_params');
  });

  it('rejects missing required params', () => {
    const result = validateAction('relay_requests', 'get', {});
    expect(result.ok).toBe(false);
    expect(result.error.message).toMatch(/requestId/);
  });

  it('rejects wrong primitive types', () => {
    expect(validateAction('relay_collections', 'create', { name: 42 }).ok).toBe(false);
    expect(validateAction('relay_execute', 'run_collection', { collectionId: 'c', iterations: '3' }).ok).toBe(false);
    expect(validateAction('relay_mock', 'start', { delayMs: Number.NaN }).ok).toBe(false);
    expect(validateAction('relay_settings', 'set_cookie', { cookie: [] }).ok).toBe(false);
  });

  it('rejects enum mismatches', () => {
    const bad = validateAction('relay_protocol', 'open', {
      protocol: 'http',
      config: { url: 'ws://x' },
    });
    expect(bad.ok).toBe(false);
    expect(bad.error.message).toMatch(/protocol/);

    const good = validateAction('relay_protocol', 'open', {
      protocol: 'ws',
      config: { url: 'ws://x' },
    });
    expect(good.ok).toBe(true);
  });

  it('accepts null for a string|null param and rejects it elsewhere', () => {
    expect(
      validateAction('relay_environments', 'activate', { environmentId: null }).ok
    ).toBe(true);
    expect(
      validateAction('relay_environments', 'activate', { environmentId: 'env_1' }).ok
    ).toBe(true);
    expect(validateAction('relay_workspaces', 'rename', { workspaceId: null, name: 'x' }).ok).toBe(
      false
    );
  });

  it('accepts a JSON string for import objects', () => {
    const asObject = validateAction('relay_collections', 'import_postman', {
      collection: { info: { name: 'X' } },
    });
    expect(asObject.ok).toBe(true);
    const asString = validateAction('relay_collections', 'import_postman', {
      collection: '{"info":{"name":"X"}}',
    });
    expect(asString.ok).toBe(true);
    const asGarbage = validateAction('relay_collections', 'import_postman', {
      collection: '{oops',
    });
    expect(asGarbage.ok).toBe(false);
  });
});

describe('summarizeAction', () => {
  it('describes a send with its method and URL', () => {
    const summary = summarizeAction('relay_execute', 'send', {
      request: { method: 'post', url: 'https://api.test/orders' },
    });
    expect(summary).toBe('Send POST https://api.test/orders');
  });

  it('falls back to ids and tool/action', () => {
    expect(summarizeAction('relay_execute', 'send', { requestId: 'req_1' })).toContain('req_1');
    expect(summarizeAction('relay_collections', 'delete', { collectionId: 'col_1' })).toContain(
      'col_1'
    );
    expect(summarizeAction('relay_mock', 'stop', {})).toBe('relay_mock.stop');
  });

  it('caps the summary at 300 characters', () => {
    const summary = summarizeAction('relay_execute', 'send', {
      request: { method: 'GET', url: `https://api.test/${'a'.repeat(400)}` },
    });
    expect(summary.length).toBe(300);
    expect(summary.endsWith('...')).toBe(true);
  });
});
