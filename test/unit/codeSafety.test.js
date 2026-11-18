import { describe, expect, it } from 'vitest';
import {
  hasSecretAuth,
  hasSecretRows,
  redactAuthForCode,
  safeVarsToMap,
} from '../../src/lib/codeSafety.js';

describe('code safety', () => {
  it('keeps secret variables out of the resolved code scope', () => {
    const rows = [
      { key: 'baseUrl', value: 'https://api.test', enabled: true, type: 'default' },
      { key: 'token', value: 'secret-token', enabled: true, type: 'secret' },
    ];
    expect(safeVarsToMap(rows)).toEqual({ baseUrl: 'https://api.test' });
    expect(hasSecretRows(rows)).toBe(true);
    expect(hasSecretRows([{ key: 'baseUrl', value: 'x' }])).toBe(false);
  });

  it('redacts auth credentials and detects them', () => {
    const auth = {
      type: 'bearer',
      bearer: { token: 'bearer-secret' },
      apikey: { key: 'X-API-Key', value: 'api-secret' },
    };
    const safe = redactAuthForCode(auth);
    expect(safe.bearer.token).toBe('{{TOKEN}}');
    expect(safe.apikey.key).toBe('X-API-Key');
    expect(safe.apikey.value).toBe('{{API_KEY}}');
    expect(hasSecretAuth(auth)).toBe(true);
    expect(hasSecretAuth({ type: 'none' })).toBe(false);
    expect(hasSecretAuth({ type: 'basic', basic: { username: 'u', password: '' } })).toBe(false);
  });
});
