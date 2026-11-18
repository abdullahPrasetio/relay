// Helpers for showing generated code without leaking resolved secrets.
// The Code panel resolves normal variables, but secret variables and auth
// credentials stay as placeholders unless the user explicitly reveals them.
import { varsToMap } from '../../packages/core/src/variables.js';

const SECRET_KEY_RE = /(authorization|token|secret|password|passphrase|api[-_]?key|private[-_]?key)/i;

export function safeVarsToMap(rows) {
  return varsToMap((rows || []).filter((row) => row?.type !== 'secret'));
}

export function hasSecretRows(...lists) {
  return lists.some((rows) =>
    (rows || []).some((row) => row?.type === 'secret' && row?.value)
  );
}

export function redactAuthForCode(auth) {
  if (!auth || typeof auth !== 'object' || auth.type === 'none' || auth.type === 'inherit') {
    return auth;
  }
  const clone = JSON.parse(JSON.stringify(auth));
  const walk = (node, parentKey = '') => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      const sensitive =
        SECRET_KEY_RE.test(key) || (parentKey === 'apikey' && key === 'value');
      if (typeof value === 'string' && sensitive && value) {
        node[key] = parentKey === 'apikey' && key === 'value' ? '{{API_KEY}}' : `{{${key.toUpperCase()}}}`;
      } else {
        walk(value, key);
      }
    }
  };
  walk(clone);
  return clone;
}

export function hasSecretAuth(auth) {
  if (!auth || typeof auth !== 'object' || auth.type === 'none' || auth.type === 'inherit') {
    return false;
  }
  let found = false;
  const walk = (node, parentKey = '') => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      const sensitive =
        SECRET_KEY_RE.test(key) || (parentKey === 'apikey' && key === 'value');
      if (typeof value === 'string' && sensitive && value) found = true;
      else walk(value, key);
    }
  };
  walk(auth);
  return found;
}
