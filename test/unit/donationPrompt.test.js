import { describe, expect, it } from 'vitest';
import {
  DONATION_PROMPT_KEY,
  localDateKey,
  markDonationPromptShown,
  shouldShowDonationPrompt,
} from '../../src/lib/donationPrompt.js';

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

describe('donation prompt', () => {
  it('shows once per local calendar day', () => {
    const storage = memoryStorage();
    const morning = new Date(2026, 10, 11, 8, 0, 0);
    const evening = new Date(2026, 10, 11, 22, 0, 0);
    const tomorrow = new Date(2026, 10, 12, 0, 1, 0);

    expect(shouldShowDonationPrompt({ now: morning, storage })).toBe(true);
    markDonationPromptShown({ now: morning, storage });
    expect(storage.getItem(DONATION_PROMPT_KEY)).toBe('2026-11-11');
    expect(shouldShowDonationPrompt({ now: evening, storage })).toBe(false);
    expect(shouldShowDonationPrompt({ now: tomorrow, storage })).toBe(true);
  });

  it('treats unavailable or throwing storage as already shown', () => {
    expect(shouldShowDonationPrompt({ storage: null })).toBe(false);
    const throwing = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    };
    expect(shouldShowDonationPrompt({ storage: throwing })).toBe(false);
    expect(markDonationPromptShown({ storage: throwing })).toBe(false);
  });

  it('formats local dates with zero padding', () => {
    expect(localDateKey(new Date(2026, 0, 2))).toBe('2026-01-02');
  });
});
