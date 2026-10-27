import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  ACCENTS,
  DEFAULT_APPEARANCE,
  MODES,
  normalizeAppearance,
  readAppearance,
  resolveThemeMode,
  writeAppearance,
} from '../../src/lib/theme.js';

describe('appearance preferences', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to the default mode and accent for unknown values', () => {
    expect(normalizeAppearance({ mode: 'neon', accent: 'chartreuse' })).toEqual({
      mode: 'system',
      accent: 'indigo',
    });
    expect(normalizeAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(normalizeAppearance('light')).toEqual(DEFAULT_APPEARANCE);
  });

  it('keeps every advertised mode and accent', () => {
    for (const mode of MODES) {
      for (const accent of ACCENTS) {
        expect(normalizeAppearance({ mode: mode.id, accent: accent.id })).toEqual({
          mode: mode.id,
          accent: accent.id,
        });
      }
    }
  });

  it('resolves system mode from the OS preference only', () => {
    expect(resolveThemeMode('system', true)).toBe('light');
    expect(resolveThemeMode('system', false)).toBe('dark');
    expect(resolveThemeMode('light', false)).toBe('light');
    expect(resolveThemeMode('dark', true)).toBe('dark');
  });

  it('reads defaults when storage is unavailable', () => {
    expect(readAppearance()).toEqual(DEFAULT_APPEARANCE);
  });

  it('round-trips through localStorage', () => {
    const store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
    });

    writeAppearance({ mode: 'light', accent: 'postman' });
    expect(readAppearance()).toEqual({ mode: 'light', accent: 'postman' });

    // Corrupt payloads degrade to defaults instead of throwing.
    store.set('relay-appearance', '{not json');
    expect(readAppearance()).toEqual(DEFAULT_APPEARANCE);
  });
});
