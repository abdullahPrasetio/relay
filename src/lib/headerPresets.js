// App-level header presets, stored in localStorage like Postman's header
// presets. Presets are intentionally local-only and never exported with a
// workspace unless we add an explicit export later.
const STORAGE_KEY = 'relay-header-presets';
const MAX_PRESETS = 50;
const MAX_HEADERS = 200;

function text(value) {
  return value == null ? '' : String(value);
}

function uid() {
  return `hp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function normalizePresetHeaders(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && text(row.key).trim())
    .slice(0, MAX_HEADERS)
    .map((row) => ({
      key: text(row.key).trim(),
      value: text(row.value),
      enabled: row.enabled !== false,
    }));
}

export function normalizeHeaderPresets(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const name = text(entry.name).trim();
    if (!name || out.length >= MAX_PRESETS) continue;
    const dedupe = name.toLowerCase();
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const headers = normalizePresetHeaders(entry.headers);
    if (!headers.length) continue;
    out.push({
      id: text(entry.id) || uid(),
      name,
      headers,
    });
  }
  return out;
}

export function readHeaderPresets(storage) {
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  try {
    const raw = store?.getItem(STORAGE_KEY);
    return raw ? normalizeHeaderPresets(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function writeHeaderPresets(presets, storage) {
  const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  const normalized = normalizeHeaderPresets(presets);
  try {
    store?.setItem(STORAGE_KEY, JSON.stringify(normalized));
    return true;
  } catch {
    return false;
  }
}

export function presetFromHeaders(name, headers) {
  const cleanName = text(name).trim();
  const rows = normalizePresetHeaders(headers);
  if (!cleanName || !rows.length) return null;
  return {
    id: uid(),
    name: cleanName,
    headers: rows,
  };
}

// Merge a preset into the current header list, case-insensitively. Matching
// header names are overwritten by the preset; unrelated headers stay put.
export function mergeHeaderPreset(current, presetHeaders) {
  const rows = (Array.isArray(current) ? current : []).filter(Boolean);
  const index = new Map();
  rows.forEach((row, i) => {
    if (row.key) index.set(String(row.key).toLowerCase(), i);
  });
  const next = rows.map((row) => ({ ...row }));
  for (const header of normalizePresetHeaders(presetHeaders)) {
    const at = index.get(header.key.toLowerCase());
    if (at == null) {
      index.set(header.key.toLowerCase(), next.length);
      next.push({ ...header });
    } else {
      next[at] = { ...next[at], ...header };
    }
  }
  return next;
}

export function upsertHeaderPreset(presets, preset) {
  const list = normalizeHeaderPresets(presets);
  const at = list.findIndex(
    (entry) => entry.id === preset.id || entry.name.toLowerCase() === preset.name.toLowerCase()
  );
  if (at >= 0) list[at] = { ...list[at], ...preset };
  else list.push(preset);
  return normalizeHeaderPresets(list);
}
