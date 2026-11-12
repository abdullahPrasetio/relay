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
  { id: 'teal', label: 'Teal' },
  { id: 'cyan', label: 'Cyan' },
  { id: 'blue', label: 'Blue' },
  { id: 'fuchsia', label: 'Fuchsia' },
  { id: 'pink', label: 'Pink' },
  { id: 'red', label: 'Red' },
];

export const DEFAULT_APPEARANCE = Object.freeze({ mode: 'system', accent: 'indigo' });

export function normalizeHex(value) {
  const text = String(value || '').trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  if (/^#[0-9a-f]{3}$/.test(text)) {
    return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`;
  }
  return null;
}

function hexToRgb(hex) {
  const value = normalizeHex(hex);
  if (!value) return { r: 99, g: 102, b: 241 };
  return {
    r: Number.parseInt(value.slice(1, 3), 16),
    g: Number.parseInt(value.slice(3, 5), 16),
    b: Number.parseInt(value.slice(5, 7), 16),
  };
}

function lighten(hex, amount) {
  const { r, g, b } = hexToRgb(hex);
  const mix = (channel) => Math.round(channel + (255 - channel) * amount);
  return `#${[mix(r), mix(g), mix(b)]
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`;
}

export function normalizeAppearance(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const mode = MODES.some((m) => m.id === src.mode) ? src.mode : DEFAULT_APPEARANCE.mode;
  const customAccent = normalizeHex(src.customAccent);
  if (src.accent === 'custom' && customAccent) {
    return { mode, accent: 'custom', customAccent };
  }
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

  if (next.accent === 'custom' && next.customAccent) {
    const { r, g, b } = hexToRgb(next.customAccent);
    root.style.setProperty('--accent', next.customAccent);
    root.style.setProperty('--accent-2', lighten(next.customAccent, 0.28));
    root.style.setProperty('--accent-rgb', `${r} ${g} ${b}`);
  } else {
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-2');
    root.style.removeProperty('--accent-rgb');
  }
  return next;
}
