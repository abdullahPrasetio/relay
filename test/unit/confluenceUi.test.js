import { describe, expect, it } from 'vitest';
import {
  pageLink,
  parsePageId,
  validateSettingsDraft,
} from '../../src/lib/confluenceUi.js';

describe('parsePageId', () => {
  it('accepts IDs and common Confluence URLs', () => {
    expect(parsePageId('12345')).toBe('12345');
    expect(parsePageId('https://org.atlassian.net/wiki/spaces/DOCS/pages/98765/Title')).toBe(
      '98765'
    );
    expect(parsePageId('https://org.test/pages/viewpage.action?pageId=555')).toBe('555');
    expect(parsePageId('https://org.test/display/DOCS/Title')).toBe('');
    expect(parsePageId('')).toBe('');
  });
});

describe('pageLink', () => {
  it('prefers the stored URL and otherwise builds a fallback', () => {
    expect(pageLink({ baseUrl: 'https://x/wiki' }, '1', 'https://x/wiki/pages/1')).toBe(
      'https://x/wiki/pages/1'
    );
    expect(pageLink({ baseUrl: 'https://x/wiki/' }, '1')).toBe(
      'https://x/wiki/pages/viewpage.action?pageId=1'
    );
    expect(pageLink({}, '1')).toBe('');
  });
});

describe('validateSettingsDraft', () => {
  const base = { baseUrl: 'https://org.test', authMethod: 'pat', email: '', token: 't' };
  it('requires valid URLs and tokens', () => {
    expect(validateSettingsDraft(base)).toBe('');
    expect(validateSettingsDraft({ ...base, baseUrl: '' })).toMatch(/required/);
    expect(validateSettingsDraft({ ...base, baseUrl: 'ftp://x' })).toMatch(/http/);
    expect(validateSettingsDraft({ ...base, token: '', hasToken: false })).toMatch(/token/i);
    expect(validateSettingsDraft({ ...base, token: '', hasToken: true })).toBe('');
    expect(
      validateSettingsDraft({ ...base, authMethod: 'cloud', email: '', token: 't' })
    ).toMatch(/Email/);
  });
});
