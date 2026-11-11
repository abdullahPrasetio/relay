// Daily donation prompt bookkeeping.
//
// The prompt is shown at most once per local calendar day. Storage failures
// must never block startup, so reads/writes are best-effort and a failed read
// is treated as "already shown".

export const DONATION_PROMPT_KEY = 'relay-donation-last-shown';

export function localDateKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function shouldShowDonationPrompt({ now = new Date(), storage } = {}) {
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!store) return false;
  try {
    return store.getItem(DONATION_PROMPT_KEY) !== localDateKey(now);
  } catch {
    return false;
  }
}

export function markDonationPromptShown({ now = new Date(), storage } = {}) {
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!store) return false;
  try {
    store.setItem(DONATION_PROMPT_KEY, localDateKey(now));
    return true;
  } catch {
    return false;
  }
}
