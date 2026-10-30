// Public core surface of Relay.
//
// This package is the Electron-free boundary used by the desktop app, the CLI
// (`cli/relay.mjs`) and the backend monitor worker (`dist-core/relay-core.mjs`).
// The request engine, script sandbox/pm surface, variable resolution and
// stored-request wrapper all live in this directory now.

// HTTP engine and per-request network policy.
export { sendRequest, fetchOAuth2Token } from './request-engine.js';
export { createSendContext, buildTlsOptions } from './network-runtime.js';

// Stored-request execution (inheritance + variables + scripts + transport).
export {
  executeRequest,
  findStoredRequest,
  findEnvironment,
  buildExecutableRequest,
  resolveVariables,
  runStoredRequest,
} from './request.js';

// Script execution (pre-request / test) in the Node sandbox.
export { runScript } from './script-runner.js';

// Collection runner + variable/inheritance helpers.
export { runCollection } from '../../../src/lib/runner.js';
export {
  buildScopeVars,
  mergeVars,
  envToMap,
  varsToMap,
  resolveRequest,
  resolveVars,
  expandDynamicVars,
  extractPathVars,
  pathVarsToMap,
  secretValues,
  maskSecrets,
} from './variables.js';
export {
  effectiveAuth,
  withEffectiveAuth,
  combinedPreRequest,
  combinedTests,
  applyRequestPatch,
} from './inheritance.js';
export { computeAutoHeaders } from './autoHeaders.js';

// Postman import/export (collections, environments, workspace backups).
export {
  fromPostmanCollection,
  toPostmanCollection,
  fromPostmanGlobals,
  toPostmanGlobals,
  fromWorkspaceBackup,
  toWorkspaceBackup,
} from '../../../src/lib/postmanFormat.js';
export {
  fromPostmanEnvironment,
  toPostmanEnvironment,
} from '../../../src/lib/environmentFormat.js';

// Run reports.
export {
  toJsonReport,
  toJUnit,
  toHtml,
  suggestReportName,
} from '../../../src/lib/report.js';
