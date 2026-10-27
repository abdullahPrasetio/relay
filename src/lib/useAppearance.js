import { useCallback, useEffect, useState } from 'react';
import {
  applyAppearance,
  normalizeAppearance,
  readAppearance,
  systemPrefersLight,
  writeAppearance,
} from './theme.js';

// Owns the theme mode + accent for the renderer. With mode 'system' the
// resolved theme follows the OS live, without touching the stored choice.
export function useAppearance() {
  const [appearance, setAppearance] = useState(readAppearance);

  useEffect(() => {
    applyAppearance(appearance, systemPrefersLight());
  }, [appearance]);

  useEffect(() => {
    if (appearance.mode !== 'system' || typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => applyAppearance(appearance, media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [appearance]);

  const update = useCallback((patch) => {
    setAppearance((prev) => {
      const next = normalizeAppearance({ ...prev, ...patch });
      writeAppearance(next);
      return next;
    });
  }, []);

  return { appearance, update };
}
