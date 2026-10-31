// Persisted-data schema version.
//   1 — implicit shape before per-request network settings existed.
//   2 — adds `request.settings` (timeout/redirect/TLS/proxy/cookie overrides).
//   3 — adds collection Confluence page metadata (non-secret).
//
// The renderer stamps this when persisting; the main process reads it to take a
// one-time backup of the data file before a migration.
export const SCHEMA_VERSION = 3;
