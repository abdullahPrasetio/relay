// Single source of truth for the Relay MCP surface.
//
// The main process uses this catalogue for scope checks, approval policy and
// parameter validation; the renderer uses the same entries to dispatch an
// action. Keeping it in `shared/` means both sides agree by construction.
//
// Entry shape:
//   MCP_TOOLS[toolName] = { name, description, actions: { [action]: spec } }
//   spec = { scope, approval, params, description }
//
// `scope` is one of MCP_SCOPES (or null for `relay_help`); `approval` is true
// for every action that is not a pure read. `params` maps a field name to
//   { type, required, enum?, description, jsonString? }
// where type is 'string' | 'number' | 'boolean' | 'object' | 'array' |
// 'string|null'. `jsonString` marks an object field that also accepts a JSON
// string (imports and backups), which is what MCP clients naturally send.

import { MCP_SCOPE_LABELS } from './mcpScopes.js';

const field = (type, description, extra = {}) => ({
  type,
  required: false,
  description,
  ...extra,
});

const required = (type, description, extra = {}) => ({
  type,
  required: true,
  description,
  ...extra,
});

const str = (description) => field('string', description);
const strReq = (description) => required('string', description);
const num = (description) => field('number', description);
const bool = (description) => field('boolean', description);
const obj = (description) => field('object', description);
const objReq = (description) => required('object', description);
const jsonReq = (description) => required('object', description, { jsonString: true });
const arr = (description) => field('array', description);
const arrReq = (description) => required('array', description);
const nullableStrReq = (description) => required('string|null', description);

// `approval` is derived: anything that is not a read needs the user's consent
// (subject to the client's approval policy).
function action(scope, description, params = {}) {
  return { scope, approval: scope !== 'read', params, description };
}

export const MCP_TOOLS = {
  relay_help: {
    name: 'relay_help',
    description:
      'Describe every Relay tool and the exact params of each action. Call this first.',
    actions: {
      help: {
        scope: null,
        approval: false,
        params: {},
        description: 'Return the scope labels and the full tool/action/param catalogue.',
      },
    },
  },

  relay_app: {
    name: 'relay_app',
    description: 'Relay application status. Call relay_help for the exact params of each action.',
    actions: {
      info: action(
        'read',
        'Active workspace, workspace list and cloud session status.',
        {}
      ),
    },
  },

  relay_workspaces: {
    name: 'relay_workspaces',
    description:
      'List, read, create, rename, switch and delete workspaces. Call relay_help for the exact params of each action.',
    actions: {
      list: action('read', 'All workspaces with id, name and counts.', {}),
      get: action('read', 'One workspace, optionally with collections and environments.', {
        workspaceId: str('Workspace id; defaults to the active workspace.'),
        includeCollections: bool('Include the collection tree (default true).'),
        includeEnvironments: bool('Include environments (default true).'),
      }),
      create: action('write', 'Create a workspace and switch to it.', {
        name: strReq('Workspace name.'),
      }),
      rename: action('write', 'Rename a workspace.', {
        workspaceId: strReq('Workspace id.'),
        name: strReq('New name.'),
      }),
      switch: action('write', 'Make a workspace active.', {
        workspaceId: strReq('Workspace id.'),
      }),
      delete: action('write', 'Delete a workspace (never the last one).', {
        workspaceId: strReq('Workspace id.'),
      }),
    },
  },

  relay_collections: {
    name: 'relay_collections',
    description:
      'Read and edit collections, folders, tree nodes, and Postman import/export. Call relay_help for the exact params of each action.',
    actions: {
      list: action('read', 'Collections in a workspace (id, name, counts).', {
        workspaceId: str('Workspace id; defaults to the active workspace.'),
      }),
      get: action('read', 'A full collection including its tree.', {
        collectionId: strReq('Collection id.'),
        workspaceId: str('Workspace id; defaults to the active workspace.'),
      }),
      create: action('write', 'Create an empty collection.', {
        name: strReq('Collection name.'),
        description: str('Collection description.'),
        workspaceId: str('Workspace id; defaults to the active workspace.'),
      }),
      update: action('write', 'Merge a patch into a collection (name, description, auth, scripts).', {
        collectionId: strReq('Collection id.'),
        patch: objReq('Fields to merge into the collection.'),
        workspaceId: str('Workspace id; defaults to the active workspace.'),
      }),
      delete: action('write', 'Delete a collection and everything in it.', {
        collectionId: strReq('Collection id.'),
        workspaceId: str('Workspace id; defaults to the active workspace.'),
      }),
      add_folder: action('write', 'Add a folder at the collection root or inside a folder.', {
        collectionId: strReq('Collection id.'),
        parentFolderId: str('Parent folder id; omit for the collection root.'),
        name: strReq('Folder name.'),
      }),
      rename_node: action('write', 'Rename a folder or request node.', {
        collectionId: strReq('Collection id.'),
        nodeId: strReq('Folder or request id.'),
        name: strReq('New name.'),
      }),
      delete_node: action('write', 'Delete a folder or request node.', {
        collectionId: strReq('Collection id.'),
        nodeId: strReq('Folder or request id.'),
      }),
      move_node: action(
        'write',
        'Move a node into a folder/collection, or immediately before another node.',
        {
          collectionId: strReq('Collection the node currently lives in.'),
          nodeId: strReq('Folder or request id to move.'),
          targetCollectionId: str('Destination collection; defaults to the source collection.'),
          targetFolderId: str('Destination folder id; omit for the collection root.'),
          beforeNodeId: str('Insert immediately before this node id (drag-drop ordering).'),
        }
      ),
      duplicate_node: action('write', 'Duplicate a folder or request node.', {
        collectionId: strReq('Collection id.'),
        nodeId: strReq('Folder or request id.'),
      }),
      import_postman: action('write', 'Import a Postman collection (v2 object or JSON string).', {
        workspaceId: str('Workspace id; defaults to the active workspace.'),
        collection: jsonReq('Postman collection object or its JSON string.'),
      }),
      export_postman: action('read', 'Export a collection as a Postman v2 object.', {
        workspaceId: str('Workspace id; defaults to the active workspace.'),
        collectionId: strReq('Collection id.'),
      }),
    },
  },

  relay_requests: {
    name: 'relay_requests',
    description:
      'Read and edit requests inside collections. Call relay_help for the exact params of each action.',
    actions: {
      list: action('read', 'Requests in a workspace or collection (id, name, method, url).', {
        workspaceId: str('Workspace id; defaults to the active workspace.'),
        collectionId: str('Only requests in this collection.'),
      }),
      get: action('read', 'One stored request.', {
        requestId: strReq('Request id.'),
        workspaceId: str('Workspace id; defaults to the active workspace.'),
        collectionId: str('Collection id, when the id is ambiguous.'),
      }),
      create: action('write', 'Create a request in a collection or folder.', {
        collectionId: strReq('Collection id.'),
        parentFolderId: str('Folder id; omit for the collection root.'),
        request: objReq('Request fields (method, url, headers, body, ...).'),
      }),
      update: action('write', 'Merge a patch into a stored request.', {
        requestId: strReq('Request id.'),
        patch: objReq('Fields to merge; body/auth/settings/mock/grpc merge deeply.'),
        workspaceId: str('Workspace id; defaults to the active workspace.'),
        collectionId: str('Collection id, when the id is ambiguous.'),
      }),
      delete: action('write', 'Delete a stored request.', {
        requestId: strReq('Request id.'),
        workspaceId: str('Workspace id; defaults to the active workspace.'),
        collectionId: str('Collection id, when the id is ambiguous.'),
      }),
      duplicate: action('write', 'Duplicate a request in place.', {
        collectionId: strReq('Collection id.'),
        requestId: strReq('Request id.'),
      }),
    },
  },

  relay_environments: {
    name: 'relay_environments',
    description:
      'Read and edit environments and globals. Call relay_help for the exact params of each action.',
    actions: {
      list: action('read', 'Environments plus the active environment id.', {
        workspaceId: str('Workspace id; defaults to the active workspace.'),
      }),
      create: action('write', 'Create an environment.', {
        name: strReq('Environment name.'),
        variables: arr('Variable rows: [{key,value,enabled,type}].'),
        workspaceId: str('Workspace id; defaults to the active workspace.'),
      }),
      update: action('write', 'Rename an environment and/or replace its variables.', {
        environmentId: strReq('Environment id.'),
        name: str('New name.'),
        variables: arr('Full replacement variable row list.'),
        workspaceId: str('Workspace id; defaults to the active workspace.'),
      }),
      delete: action('write', 'Delete an environment.', {
        environmentId: strReq('Environment id.'),
        workspaceId: str('Workspace id; defaults to the active workspace.'),
      }),
      activate: action('write', 'Activate an environment (null deactivates).', {
        environmentId: nullableStrReq('Environment id, or null to clear the selection.'),
        workspaceId: str('Workspace id; defaults to the active workspace.'),
      }),
      set_globals: action('write', 'Replace the workspace global variables.', {
        variables: arrReq('Full replacement variable row list.'),
        workspaceId: str('Workspace id; defaults to the active workspace.'),
      }),
    },
  },

  relay_execute: {
    name: 'relay_execute',
    description:
      'Send a request or run a collection through the real transport. Call relay_help for the exact params of each action.',
    actions: {
      send: action('request', 'Send one request (stored by id or inline) and return the response.', {
        requestId: str('Stored request id; when set, `request` is ignored.'),
        request: obj('Inline request object (method, url, params, headers, body, auth, ...).'),
        collectionId: str('Collection the request belongs to (for inherited auth/scripts).'),
        environmentId: str('Environment id; defaults to the active environment.'),
        saveHistory: bool('Append the result to workspace history (default false).'),
        persistVariables: bool('Persist script-mutated variables (default false).'),
      }),
      run_collection: action('request', 'Run a collection or folder like the collection runner.', {
        collectionId: strReq('Collection id.'),
        folderId: str('Run only this folder.'),
        environmentId: str('Environment id; defaults to the active environment.'),
        iterations: num('Repeat count when no data rows are given (default 1).'),
        delayMs: num('Delay between requests in ms.'),
        data: arr('Data rows for data-driven iterations.'),
        stopOnError: bool('Stop the run after the first failed step.'),
        retries: num('Extra attempts for failed or 5xx requests.'),
        retryDelayMs: num('Delay between retries in ms.'),
        saveResponses: bool('Include a truncated response snapshot per step (default true).'),
        persistVariables: bool('Persist script-mutated variables (default false).'),
      }),
    },
  },

  relay_protocol: {
    name: 'relay_protocol',
    description:
      'WebSocket, MQTT, Socket.IO and gRPC sessions. Call relay_help for the exact params of each action.',
    actions: {
      open: action('request', 'Open a ws/mqtt/socketio session and return its session id.', {
        protocol: required('string', 'Transport to open.', { enum: ['ws', 'mqtt', 'socketio'] }),
        config: objReq(
          'ws: {url,headers,protocols}; mqtt: {url,username,password,clientId,keepalive,clean}; socketio: {url,auth,headers}.'
        ),
      }),
      send: action('request', 'Publish/emit on an open session.', {
        sessionId: strReq('Session id returned by `open`.'),
        payload: objReq(
          'ws: {type:"text"|"binary",data|base64}; mqtt: {op:"publish"|"subscribe"|"unsubscribe",topic,payload,qos,retain}; socketio: {op:"emit",event,args}.'
        ),
      }),
      close: action('request', 'Close a session.', {
        sessionId: strReq('Session id returned by `open`.'),
      }),
      events: action('request', 'Read buffered events after a sequence number.', {
        sessionId: strReq('Session or gRPC stream id.'),
        after: num('Only return events with a sequence number greater than this.'),
      }),
      grpc_services: action('request', 'List gRPC services/methods for a proto file.', {
        request: objReq('Request object with a `grpc` block (protoPath, reflection).'),
      }),
      grpc_invoke: action('request', 'Invoke a unary gRPC method.', {
        request: objReq('Request object with a `grpc` block (protoPath, service, method, message).'),
      }),
      grpc_stream_start: action('request', 'Start a server-streaming gRPC call.', {
        request: objReq('Request object with a `grpc` block and streaming:true.'),
      }),
      grpc_stream_cancel: action('request', 'Cancel a running gRPC stream.', {
        streamId: strReq('Stream id returned by `grpc_stream_start`.'),
      }),
    },
  },

  relay_mock: {
    name: 'relay_mock',
    description:
      'Control the local mock server. Call relay_help for the exact params of each action.',
    actions: {
      status: action('read', 'Mock server status, routes and recent logs.', {}),
      start: action('mock', 'Start (or restart) the mock server.', {
        collectionId: str('Serve only this collection; omit to serve all.'),
        port: num('Port to listen on (default 0 picks a free port).'),
        delayMs: num('Artificial response delay in ms.'),
      }),
      stop: action('mock', 'Stop the mock server.', {}),
      reload: action('mock', 'Apply edited scenarios without dropping the listener.', {
        collectionId: str('Reload only this collection.'),
      }),
      select_scenario: action('mock', 'Force a scenario at runtime, or clear the override.', {
        requestId: strReq('Request id.'),
        scenarioId: nullableStrReq('Scenario id, or null to return to automatic matching.'),
      }),
    },
  },

  relay_confluence: {
    name: 'relay_confluence',
    description:
      'Confluence configuration and page publishing. Call relay_help for the exact params of each action.',
    actions: {
      get_config: action('read', 'Confluence configuration (never the token).', {
        workspaceId: str('Workspace id; defaults to the active workspace.'),
      }),
      set_config: action('confluence', 'Save the Confluence connection for a workspace.', {
        workspaceId: strReq('Workspace id.'),
        baseUrl: strReq('Confluence base URL.'),
        authMethod: str('Auth method (basic or token).'),
        email: str('Account email for basic auth.'),
        token: str('API token; omit to keep the stored one.'),
        allowInsecureTls: bool('Allow self-signed certificates.'),
      }),
      test: action('confluence', 'Test the stored Confluence connection.', {
        workspaceId: str('Workspace id; defaults to the active workspace.'),
      }),
      publish: action('confluence', 'Publish or update a collection page.', {
        workspaceId: str('Workspace id; defaults to the active workspace.'),
        collectionId: strReq('Collection id.'),
        pageId: str('Existing page id to update.'),
        title: str('Page title; defaults to the collection Confluence title.'),
        spaceKey: str('Space key for a new page.'),
        parentPageId: str('Parent page id for a new page.'),
        force: bool('Publish even when the local copy is not newer.'),
      }),
    },
  },

  relay_cloud: {
    name: 'relay_cloud',
    description:
      'Relay Cloud status, sync, members, devices, monitors and comments. Call relay_help for the exact params of each action.',
    actions: {
      status: action('read', 'Cloud session status and account.', {}),
      list_workspaces: action('read', 'Remote workspaces visible to this account.', {}),
      attach: action('cloud', 'Attach a local workspace to Relay Cloud.', {
        workspaceId: strReq('Workspace id.'),
      }),
      detach: action('cloud', 'Detach a local workspace from Relay Cloud.', {
        workspaceId: strReq('Workspace id.'),
      }),
      sync: action('cloud', 'Push and pull changes for an attached workspace.', {
        workspaceId: strReq('Workspace id.'),
      }),
      members: action('read', 'Members of a cloud workspace.', {
        workspaceId: strReq('Workspace id.'),
      }),
      invite: action('cloud', 'Create an invite link for a cloud workspace.', {
        workspaceId: strReq('Workspace id.'),
        role: str('Member role (viewer, editor, admin).'),
        expiresInHours: num('Invite lifetime in hours.'),
      }),
      update_member: action('cloud', 'Change a member role.', {
        workspaceId: strReq('Workspace id.'),
        userId: strReq('Member user id.'),
        role: strReq('New role.'),
      }),
      remove_member: action('cloud', 'Remove a member from a workspace.', {
        workspaceId: strReq('Workspace id.'),
        userId: strReq('Member user id.'),
      }),
      audit: action('read', 'Audit log entries for a workspace.', {
        workspaceId: strReq('Workspace id.'),
        limit: num('Maximum entries.'),
      }),
      devices: action('read', 'Signed-in devices.', {}),
      revoke_device: action('cloud', 'Revoke a device session.', {
        deviceId: strReq('Device id.'),
      }),
      comments: action('read', 'Comments on a workspace entity.', {
        workspaceId: strReq('Workspace id.'),
        entityId: str('Only comments on this entity.'),
        before: str('Cursor for pagination.'),
        limit: num('Maximum comments.'),
      }),
      create_comment: action('cloud', 'Create a comment.', {
        workspaceId: strReq('Workspace id.'),
        comment: objReq('Comment payload (entityId, body, mentions).'),
      }),
      update_comment: action('cloud', 'Edit a comment.', {
        commentId: strReq('Comment id.'),
        patch: objReq('Fields to change (body, resolved).'),
      }),
      delete_comment: action('cloud', 'Delete a comment.', {
        commentId: strReq('Comment id.'),
      }),
      mentions: action('read', 'Comments that mention the signed-in user.', {
        workspaceId: strReq('Workspace id.'),
        before: str('Cursor for pagination.'),
        limit: num('Maximum comments.'),
      }),
      monitors: action('read', 'Scheduled monitors for a workspace.', {
        workspaceId: strReq('Workspace id.'),
      }),
      create_monitor: action('cloud', 'Create a scheduled monitor.', {
        workspaceId: strReq('Workspace id.'),
        monitor: objReq('Monitor payload (name, collectionId, interval, ...).'),
      }),
      get_monitor: action('read', 'One monitor.', {
        monitorId: strReq('Monitor id.'),
      }),
      update_monitor: action('cloud', 'Change a monitor.', {
        monitorId: strReq('Monitor id.'),
        patch: objReq('Fields to change.'),
      }),
      delete_monitor: action('cloud', 'Delete a monitor.', {
        monitorId: strReq('Monitor id.'),
      }),
      run_monitor: action('cloud', 'Run a monitor now.', {
        monitorId: strReq('Monitor id.'),
      }),
      monitor_runs: action('read', 'Recent runs of a monitor.', {
        monitorId: strReq('Monitor id.'),
        limit: num('Maximum runs.'),
      }),
    },
  },

  relay_settings: {
    name: 'relay_settings',
    description:
      'Network settings, cookies, history and appearance. Call relay_help for the exact params of each action.',
    actions: {
      get_network: action('read', 'Network settings (secrets stay encrypted).', {}),
      set_network: action('settings', 'Save network settings.', {
        settings: objReq('Settings payload in the shape returned by get_network.'),
      }),
      get_cookies: action('read', 'The cookie jar.', {}),
      set_cookie: action('settings', 'Insert or replace a cookie.', {
        cookie: objReq('{name,value,domain,path,secure,httpOnly,expires}.'),
      }),
      delete_cookie: action('settings', 'Delete a cookie by identity.', {
        identity: objReq('{name,domain,path}.'),
      }),
      clear_cookies: action('settings', 'Empty the cookie jar.', {}),
      get_history: action('read', 'Request history.', {
        workspaceId: str('Workspace id; defaults to the active workspace.'),
        limit: num('Maximum entries.'),
      }),
      clear_history: action('settings', 'Clear request history.', {
        workspaceId: str('Workspace id; defaults to the active workspace.'),
      }),
      get_appearance: action('read', 'Theme mode and accent.', {}),
      set_appearance: action('settings', 'Change the theme.', {
        mode: str('Theme mode (dark or light).'),
        accent: str('Accent id.'),
      }),
    },
  },

  relay_docs: {
    name: 'relay_docs',
    description:
      'Generate collection documentation. Call relay_help for the exact params of each action.',
    actions: {
      collection_html: action('read', 'Render a collection as a standalone HTML page.', {
        workspaceId: str('Workspace id; defaults to the active workspace.'),
        collectionId: strReq('Collection id.'),
        includeExamples: bool('Include saved examples.'),
      }),
      collection_confluence: action('read', 'Render a collection as Confluence storage format.', {
        workspaceId: str('Workspace id; defaults to the active workspace.'),
        collectionId: strReq('Collection id.'),
        includeExamples: bool('Include saved examples.'),
      }),
    },
  },

  relay_backup: {
    name: 'relay_backup',
    description:
      'Whole-workspace backup and restore. Call relay_help for the exact params of each action.',
    actions: {
      export_workspace: action('read', 'Export a workspace as a portable backup object.', {
        workspaceId: str('Workspace id; defaults to the active workspace.'),
      }),
      import_workspace: action('write', 'Create a new workspace from a backup object.', {
        backup: jsonReq('Backup object (from export_workspace) or its JSON string.'),
      }),
    },
  },
};

export const MCP_TOOL_NAMES = Object.keys(MCP_TOOLS);

const TYPE_LABELS = {
  string: 'a string',
  number: 'a number',
  boolean: 'a boolean',
  object: 'an object',
  array: 'an array',
  'string|null': 'a string or null',
};

function fail(message) {
  return { ok: false, error: { code: 'invalid_params', message } };
}

export function getActionSpec(tool, action) {
  const entry = MCP_TOOLS[tool];
  if (!entry) return null;
  return entry.actions[action] || null;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function typeMatches(type, value, spec) {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      if (isPlainObject(value)) return true;
      // Imports and backups arrive as JSON strings from most MCP clients.
      if (spec?.jsonString && typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          return isPlainObject(parsed) || Array.isArray(parsed);
        } catch {
          return false;
        }
      }
      return false;
    case 'string|null':
      return value === null || typeof value === 'string';
    default:
      return false;
  }
}

/**
 * Validate a tool/action call.
 * Returns `{ok:true, params}` with only the declared fields, or
 * `{ok:false, error:{code:'invalid_params', message}}`.
 */
export function validateAction(tool, action, params = {}) {
  const entry = MCP_TOOLS[tool];
  if (!entry) return fail(`Unknown tool "${tool}".`);
  const spec = entry.actions[action];
  if (!spec) return fail(`Unknown action "${action}" for tool "${tool}".`);

  if (params == null) params = {};
  if (!isPlainObject(params)) return fail('params must be an object.');

  for (const key of Object.keys(params)) {
    if (!(key in spec.params)) return fail(`Unknown param "${key}" for ${tool}.${action}.`);
  }

  const out = {};
  for (const [key, def] of Object.entries(spec.params)) {
    const value = params[key];
    if (value === undefined) {
      if (def.required) return fail(`Missing required param "${key}".`);
      continue;
    }
    if (value === null && def.type !== 'string|null') {
      if (def.required) return fail(`Missing required param "${key}".`);
      continue;
    }
    if (!typeMatches(def.type, value, def)) {
      return fail(`Param "${key}" must be ${TYPE_LABELS[def.type] || def.type}.`);
    }
    if (Array.isArray(def.enum) && !def.enum.includes(value)) {
      return fail(`Param "${key}" must be one of: ${def.enum.join(', ')}.`);
    }
    out[key] = value;
  }
  return { ok: true, params: out };
}

const SUMMARY_LIMIT = 300;

/**
 * One-line description of a call, shown in the approval modal. Never includes
 * request bodies or headers: only the method/URL or the target id/name.
 */
export function summarizeAction(tool, action, params = {}) {
  const p = isPlainObject(params) ? params : {};
  const text = (value) => (value == null ? '' : String(value).trim());
  let summary;

  if (tool === 'relay_execute' && action === 'send') {
    const request = isPlainObject(p.request) ? p.request : null;
    const url = text(request?.url);
    if (url) {
      summary = `Send ${text(request?.method || 'GET').toUpperCase()} ${url}`;
    } else if (p.requestId) {
      summary = `Send stored request ${text(p.requestId)}`;
    } else {
      summary = 'Send an inline request';
    }
  } else if (tool === 'relay_execute' && action === 'run_collection') {
    summary = `Run collection ${text(p.collectionId) || '(unknown)'}${
      p.folderId ? ` folder ${text(p.folderId)}` : ''
    }`;
  } else if (tool === 'relay_protocol' && action === 'open') {
    summary = `Open ${text(p.protocol) || 'protocol'} session`;
  } else if (tool === 'relay_protocol') {
    summary = `${tool}.${action}: ${text(p.sessionId || p.streamId) || 'gRPC request'}`;
  } else {
    const target =
      p.name ||
      p.title ||
      p.workspaceId ||
      p.collectionId ||
      p.requestId ||
      p.environmentId ||
      p.monitorId ||
      p.commentId ||
      p.entityId ||
      p.userId ||
      p.deviceId ||
      p.pageId ||
      p.baseUrl ||
      p.nodeId;
    summary = target ? `${tool}.${action}: ${text(target)}` : `${tool}.${action}`;
  }

  return summary.length > SUMMARY_LIMIT
    ? `${summary.slice(0, SUMMARY_LIMIT - 3)}...`
    : summary;
}

/** Everything a client needs to build calls without guessing. */
export function helpPayload() {
  return { scopes: MCP_SCOPE_LABELS, tools: MCP_TOOLS };
}
