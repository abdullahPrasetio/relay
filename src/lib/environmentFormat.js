// Convert between our environment shape and Postman's environment export
// format, so environments can be exchanged with real Postman.
import { newEnvironment, uid } from './factory.js';

// Secret rows never leave the app in plaintext: only the key survives, with
// Postman's `type: 'secret'` marker. The ciphertext (`secretEnc`) is internal
// and is never exported.
function toPostmanValue(v) {
  if (v.type === 'secret') {
    return { key: v.key, value: '', type: 'secret', enabled: v.enabled !== false };
  }
  return { key: v.key, value: v.value ?? '', type: 'default', enabled: v.enabled !== false };
}

// ---- EXPORT: internal environment -> Postman environment JSON ----
export function toPostmanEnvironment(env) {
  return {
    id: env.id,
    name: env.name,
    values: (env.variables || []).filter((v) => v && v.key).map(toPostmanValue),
    _postman_variable_scope: 'environment',
    _postman_exported_at: new Date().toISOString(),
  };
}

// ---- IMPORT: Postman environment JSON -> internal environment ----
export function fromPostmanEnvironment(json) {
  const env = newEnvironment(json?.name || 'Imported Environment');
  env.id = json?.id || uid('env');
  const values = Array.isArray(json?.values) ? json.values : [];
  env.variables = values.map((v) => {
    const row = {
      key: v.key || '',
      value: v.value ?? '',
      enabled: v.enabled !== false,
    };
    if (v.type === 'secret') {
      row.type = 'secret';
      row.value = '';
    }
    return row;
  });
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
