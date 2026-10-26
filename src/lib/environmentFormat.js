// Convert between our environment shape and Postman's environment export
// format, so environments can be exchanged with real Postman.
import { newEnvironment, uid } from './factory.js';

// ---- EXPORT: internal environment -> Postman environment JSON ----
export function toPostmanEnvironment(env) {
  return {
    id: env.id,
    name: env.name,
    values: (env.variables || [])
      .filter((v) => v.key)
      .map((v) => ({
        key: v.key,
        value: v.value ?? '',
        type: 'default',
        enabled: v.enabled !== false,
      })),
    _postman_variable_scope: 'environment',
    _postman_exported_at: new Date().toISOString(),
  };
}

// ---- IMPORT: Postman environment JSON -> internal environment ----
export function fromPostmanEnvironment(json) {
  const env = newEnvironment(json?.name || 'Imported Environment');
  env.id = json?.id || uid('env');
  const values = Array.isArray(json?.values) ? json.values : [];
  env.variables = values.map((v) => ({
    key: v.key || '',
    value: v.value ?? '',
    enabled: v.enabled !== false,
  }));
  return env;
}

// Heuristic: does this JSON look like a Postman environment (vs a collection)?
export function looksLikeEnvironment(json) {
  return (
    json &&
    Array.isArray(json.values) &&
    (json._postman_variable_scope === 'environment' || !json.item)
  );
}
