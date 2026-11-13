import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearResponseHistory,
  loadResponseHistory,
  saveResponseHistory,
} from '../../src/lib/responseHistoryStore.js';

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    this.map.set(key, String(value));
  }
  removeItem(key) {
    this.map.delete(key);
  }
}

beforeEach(() => {
  globalThis.localStorage = new MemoryStorage();
});

describe('response history store', () => {
  it('saves and loads entries per workspace and request', () => {
    saveResponseHistory('ws_1', 'req_1', [
      { id: 'a', at: 1, body: '{"a":1}' },
    ]);
    expect(loadResponseHistory('ws_1', 'req_1')).toEqual([
      { id: 'a', at: 1, body: '{"a":1}' },
    ]);
    expect(loadResponseHistory('ws_2', 'req_1')).toEqual([]);
  });

  it('keeps only the newest ten entries and caps body size', () => {
    const entries = Array.from({ length: 12 }, (_, index) => ({
      id: `e${index}`,
      at: index,
      body: index === 11 ? 'x'.repeat(200 * 1024) : 'small',
    }));
    saveResponseHistory('ws', 'req', entries);
    const loaded = loadResponseHistory('ws', 'req');
    expect(loaded).toHaveLength(10);
    expect(loaded[0].id).toBe('e2');
    expect(loaded.at(-1).body.length).toBe(128 * 1024);
  });

  it('clears a request history', () => {
    saveResponseHistory('ws', 'req', [{ id: 'a', at: 1, body: 'x' }]);
    clearResponseHistory('ws', 'req');
    expect(loadResponseHistory('ws', 'req')).toEqual([]);
  });
});
