import { describe, expect, it } from 'vitest';
import {
  mergeHeaderPreset,
  normalizeHeaderPresets,
  presetFromHeaders,
  readHeaderPresets,
  upsertHeaderPreset,
  writeHeaderPresets,
} from '../../src/lib/headerPresets.js';

function memoryStorage(initial = null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    },
  };
}

describe('header presets', () => {
  it('normalizes, stores, and reads presets', () => {
    const preset = presetFromHeaders('JSON', [
      { key: 'Accept', value: 'application/json', enabled: true },
      { key: '', value: 'ignored' },
    ]);
    const storage = memoryStorage();
    expect(writeHeaderPresets([preset], storage)).toBe(true);
    expect(readHeaderPresets(storage)).toEqual([preset]);
  });

  it('merges preset headers case-insensitively and keeps unrelated rows', () => {
    const merged = mergeHeaderPreset(
      [
        { key: 'accept', value: 'text/plain', enabled: true },
        { key: 'X-Keep', value: '1', enabled: true },
      ],
      [
        { key: 'Accept', value: 'application/json', enabled: true },
        { key: 'X-New', value: '2', enabled: true },
      ]
    );
    expect(merged).toEqual([
      { key: 'Accept', value: 'application/json', enabled: true },
      { key: 'X-Keep', value: '1', enabled: true },
      { key: 'X-New', value: '2', enabled: true },
    ]);
  });

  it('replaces a preset with the same name', () => {
    const first = presetFromHeaders('Auth', [{ key: 'A', value: '1', enabled: true }]);
    const second = presetFromHeaders('auth', [{ key: 'B', value: '2', enabled: true }]);
    const list = upsertHeaderPreset([first], second);
    expect(list).toHaveLength(1);
    expect(list[0].headers).toEqual([{ key: 'B', value: '2', enabled: true }]);
  });

  it('drops duplicate and empty presets', () => {
    expect(
      normalizeHeaderPresets([
        { name: 'One', headers: [{ key: 'A', value: '1' }] },
        { name: 'one', headers: [{ key: 'B', value: '2' }] },
        { name: '', headers: [{ key: 'C', value: '3' }] },
      ])
    ).toHaveLength(1);
  });
});
