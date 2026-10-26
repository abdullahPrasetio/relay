import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_NETWORK_SETTINGS,
  normalizeNetworkSettings,
  sanitizeNetworkSettings,
} from '../../shared/networkSettings.js';

// App-level network settings live in the main process (they hold encrypted
// secrets and are needed by the request engine). In browser-only mode we fall
// back to localStorage and never accept secrets.
//
// State always holds the *sanitized* view: secrets appear only as presence
// flags (`hasPassword`, `hasClientCertPassphrase`).
const hasBridge = typeof window !== 'undefined' && !!window.api;
const LS_KEY = 'relay-network-settings';

function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return sanitizeNetworkSettings(JSON.parse(raw));
  } catch {
    /* ignore corrupt storage */
  }
  return sanitizeNetworkSettings(DEFAULT_NETWORK_SETTINGS);
}

export function useNetworkSettings() {
  const [settings, setSettings] = useState(() =>
    sanitizeNetworkSettings(DEFAULT_NETWORK_SETTINGS)
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    if (!hasBridge) {
      setSettings(loadLocal());
      setLoading(false);
      return () => {
        mounted = false;
      };
    }
    window.api
      .getNetworkSettings()
      .then((loaded) => {
        // The main process already sanitizes; do not re-sanitize (that would
        // discard the presence flags).
        if (mounted) setSettings(loaded || sanitizeNetworkSettings(DEFAULT_NETWORK_SETTINGS));
      })
      .catch(() => {
        /* keep defaults */
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  // Persist and adopt the result the main process returns. Rejects when
  // persistence fails (e.g. secure storage unavailable), so the modal can
  // show the reason and stay open.
  const save = useCallback(async (next) => {
    if (hasBridge) {
      const saved = await window.api.setNetworkSettings(next);
      setSettings(saved);
      return saved;
    }
    const normalized = normalizeNetworkSettings(next);
    localStorage.setItem(LS_KEY, JSON.stringify(normalized));
    const view = sanitizeNetworkSettings(normalized);
    setSettings(view);
    return view;
  }, []);

  return { settings, loading, save };
}
