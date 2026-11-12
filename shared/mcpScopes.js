// Scopes an MCP client can be granted. Kept in `shared/` because the main
// process enforces them and the renderer shows them in the settings modal.
//
// `read` is the only scope a new client starts with; every other scope is
// opt-in per client and, by default, still requires per-call approval.
export const MCP_SCOPES = [
  'read',
  'secrets',
  'request',
  'write',
  'mock',
  'confluence',
  'cloud',
  'settings',
];

export const MCP_SCOPE_LABELS = {
  read: 'Read workspaces, requests, environments, history, docs, and status',
  secrets:
    'Read plaintext secrets when the workspace or collection explicitly allows it',
  request: 'Send requests, run collections, and open protocol sessions',
  write: 'Create, edit, delete, import, or switch workspaces/collections/requests/environments',
  mock: 'Start/stop the mock server and switch scenarios',
  confluence: 'Configure Confluence and publish pages',
  cloud: 'Sync, team/member/device/monitor/comment operations',
  settings: 'Change network settings, cookies, and appearance',
};
