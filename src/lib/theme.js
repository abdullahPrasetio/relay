// Appearance preferences (theme mode + accent). Colors themselves live in
// styles.css so the pre-paint boot script only has to set attributes; the CSS
// palette is the single source of truth for every accent.

export const APPEARANCE_KEY = 'relay-appearance';

export const MODES = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

export const ACCENTS = [
  { id: 'indigo', label: 'Indigo' },
  { id: 'postman', label: 'Postman' },
  { id: 'sky', label: 'Sky' },
  { id: 'emerald', label: 'Emerald' },
  { id: 'violet', label: 'Violet' },
  { id: 'rose', label: 'Rose' },
  { id: 'amber', label: 'Amber' },
  { id: 'slate', label: 'Slate' },
];

export const DEFAULT_APPEARANCE = Object.freeze({ mode: 'system', accent: 'indigo' });

export function normalizeAppearance(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const mode = MODES.some((m) => m.id === src.mode) ? src.mode : DEFAULT_APPEARANCE.mode;
  const accent = ACCENTS.some((a) => a.id === src.accent)
    ? src.accent
    : DEFAULT_APPEARANCE.accent;
  return { mode, accent };
}

// 'system' resolves against the OS preference; everything else is explicit.
export function resolveThemeMode(mode, prefersLight) {
  if (mode === 'light' || mode === 'dark') return mode;
  return prefersLight ? 'light' : 'dark';
}

export function systemPrefersLight() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-color-scheme: light)').matches;
}

export function readAppearance() {
  try {
    return normalizeAppearance(JSON.parse(localStorage.getItem(APPEARANCE_KEY) || 'null'));
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

export function writeAppearance(appearance) {
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(normalizeAppearance(appearance)));
  } catch {
    /* storage unavailable: keep the in-memory choice for this session */
  }
}

export function applyAppearance(appearance, prefersLight) {
  const next = normalizeAppearance(appearance);
  const root = document.documentElement;
  const mode = resolveThemeMode(next.mode, prefersLight);
  root.dataset.theme = mode;
  root.dataset.accent = next.accent;
  root.style.colorScheme = mode;
  return next;
}
