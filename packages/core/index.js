// Public core surface of Relay.
//
// This is the intended package boundary for reusable, Electron-free pieces of
// the app: the request engine, the collection runner, variable resolution,
// Postman import/export, and report serializers.
//
// STATUS: this file is a re-export facade. The implementations still live in
// `src/lib/` and `electron/` because the Electron main process bundles those
// modules directly. No code is duplicated here; moving the files into this
// package is a separate extraction (it would require updating the Vite/Electron
// build inputs and every renderer import). Until then, consumers should import
// from this entry point only, so the future move stays source-compatible.

// HTTP engine and per-request network policy.
export { sendRequest } from '../../electron/request-engine.js';
export { createSendContext, buildTlsOptions } from '../../electron/network-runtime.js';

// Collection runner + variable resolution.
export { runCollection } from '../../src/lib/runner.js';
export {
  buildScopeVars,
  mergeVars,
  envToMap,
  varsToMap,
  resolveRequest,
  resolveVars,
  extractPathVars,
  pathVarsToMap,
} from '../../src/lib/variables.js';

// Postman import/export (collections, environments, workspace backups).
export {
  fromPostmanCollection,
  toPostmanCollection,
  fromPostmanGlobals,
  toPostmanGlobals,
  fromWorkspaceBackup,
  toWorkspaceBackup,
} from '../../src/lib/postmanFormat.js';
export {
  fromPostmanEnvironment,
  toPostmanEnvironment,
} from '../../src/lib/environmentFormat.js';

// Run reports.
export {
  toJsonReport,
  toJUnit,
  toHtml,
  suggestReportName,
} from '../../src/lib/report.js';
