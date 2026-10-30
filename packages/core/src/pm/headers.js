// Header list helpers shared by pm.request and pm.response.
//
// Our stored headers are `{ key, value, enabled }`; Postman's HeaderList is
// case-insensitive and exposes all/get/has/one/toObject. Keeping one
// normalization + lookup implementation here avoids the two APIs drifting.

export function normalizeHeaderList(headers) {
  const list = Array.isArray(headers) ? headers : [];
  return list
    .filter((h) => h && (h.key != null || h.name != null))
    .map((h) => ({
      key: String(h.key ?? h.name ?? ''),
      value: h.value == null ? '' : String(h.value),
      enabled: h.enabled !== false && h.disabled !== true,
    }));
}

export function findHeader(headers, name) {
  const wanted = String(name ?? '').toLowerCase();
  if (!wanted) return undefined;
  return (headers || []).find((h) => String(h.key ?? h.name ?? '').toLowerCase() === wanted);
}

export function headersToObject(headers) {
  const grouped = new Map();
  for (const h of normalizeHeaderList(headers)) {
    const key = h.key.toLowerCase();
    const existing = grouped.get(key);
    if (existing) existing.value += `, ${h.value}`;
    else grouped.set(key, { key: h.key, value: h.value });
  }
  const out = {};
  for (const { key, value } of grouped.values()) out[key] = value;
  return out;
}

// Read-only API for a header list (pm.response.headers). Mutations go through
// the request variant in pm/request.js, which also records a patch.
export function buildHeadersApi(headers) {
  const list = normalizeHeaderList(headers);
  return {
    all: () => list.map((h) => ({ key: h.key, value: h.value })),
    get: (name) => {
      const hit = findHeader(list, name);
      return hit ? hit.value : undefined;
    },
    has: (name) => Boolean(findHeader(list, name)),
    one: (name) => {
      const hit = name == null ? list[0] : findHeader(list, name);
      return hit ? { key: hit.key, value: hit.value } : undefined;
    },
    toObject: () => headersToObject(list),
    each: (fn) => {
      if (typeof fn !== 'function') return;
      for (const h of list) fn({ key: h.key, value: h.value });
    },
  };
}

// Header object accepted by pm.request.headers.add/upsert.
export function toHeaderEntry(input) {
  if (!input || typeof input !== 'object') return null;
  const key = input.key ?? input.name;
  if (key == null || String(key).trim() === '') return null;
  return {
    key: String(key),
    value: input.value == null ? '' : String(input.value),
    enabled: input.enabled !== false && input.disabled !== true,
  };
}
