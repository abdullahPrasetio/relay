// Mock scenario model and evaluation shared by the Electron main process and
// the renderer. Pure module: no Node, no DOM, no Electron.
//
// A request opts into scenarios with `request.mock`:
//   { enabled, mode: 'auto'|'manual', activeScenarioId, scenarios: [] }
// Scenario order is priority order. Conditions are ANDed.

export const MOCK_SOURCES = ['query', 'header', 'body', 'path'];
export const MOCK_OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'exists',
  'not_exists',
  'gt',
  'lt',
];

export const DEFAULT_MOCK_CONFIG = Object.freeze({
  enabled: true,
  mode: 'auto',
  activeScenarioId: null,
  scenarios: [],
});

const MAX_STATUS = 599;
const MIN_STATUS = 100;
const MAX_DELAY_MS = 10000;

function str(value) {
  return value == null ? '' : String(value);
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function headerRows(raw) {
  if (Array.isArray(raw)) {
    return raw
      .filter((row) => row && (row.key ?? row.name))
      .map((row) => ({
        key: str(row.key ?? row.name),
        value: str(row.value),
        enabled: row.enabled !== false,
      }));
  }
  if (raw && typeof raw === 'object') {
    return Object.entries(raw).map(([key, value]) => ({
      key,
      value: Array.isArray(value) ? value.join(', ') : str(value),
      enabled: true,
    }));
  }
  return [];
}

export function normalizeCondition(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const source = MOCK_SOURCES.includes(c.source) ? c.source : '';
  const operator = MOCK_OPERATORS.includes(c.operator) ? c.operator : '';
  const key = str(c.key).trim();
  // Keep an incomplete row while the user is typing; evaluation ignores
  // conditions without a key, so it can never match by accident.
  if (!source || !operator) return null;
  return {
    source,
    key,
    operator,
    value: str(c.value),
    enabled: c.enabled !== false,
  };
}

export function normalizeScenario(raw, index = 0) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const conditions = (Array.isArray(s.conditions) ? s.conditions : [])
    .map(normalizeCondition)
    .filter(Boolean);
  return {
    id: str(s.id) || `scn_${index + 1}`,
    name: str(s.name).trim() || `Scenario ${index + 1}`,
    enabled: s.enabled !== false,
    status: (() => {
      const n = typeof s.status === 'number' ? s.status : Number(s.status);
      return Number.isInteger(n) && n >= MIN_STATUS && n <= MAX_STATUS ? n : 200;
    })(),
    statusText: str(s.statusText),
    headers: headerRows(s.headers),
    body: str(s.body),
    contentType: str(s.contentType) || 'application/json',
    delayMs: clampInt(s.delayMs, 0, MAX_DELAY_MS, 0),
    isDefault: bool(s.isDefault, false),
    conditions,
  };
}

export function normalizeMockConfig(raw) {
  const m = raw && typeof raw === 'object' ? raw : {};
  const scenarios = (Array.isArray(m.scenarios) ? m.scenarios : []).map(normalizeScenario);
  const ids = new Set();
  for (const scenario of scenarios) {
    let id = scenario.id;
    let n = 2;
    while (ids.has(id)) {
      id = `${scenario.id}-${n}`;
      n += 1;
    }
    scenario.id = id;
    ids.add(id);
  }
  return {
    enabled: bool(m.enabled, true),
    mode: m.mode === 'manual' ? 'manual' : 'auto',
    activeScenarioId:
      typeof m.activeScenarioId === 'string' && ids.has(m.activeScenarioId)
        ? m.activeScenarioId
        : null,
    scenarios,
  };
}

// ---- URL/path handling ----

export function normalizePath(raw) {
  let path = String(raw || '').split('#')[0].split('?')[0];
  if (!path) return '/';
  if (!path.startsWith('/')) path = '/' + path;
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return path || '/';
}

// Path only: strip query/fragment and any scheme+authority. Requests may also
// be stored as "example.com/path" or "{{baseUrl}}/path"; both are tolerated.
export function pathnameOf(rawUrl) {
  let path = String(rawUrl || '').trim();
  if (!path) return '/';
  path = path.split('#')[0].split('?')[0];

  const absolute = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*(.*)$/.exec(path);
  if (absolute) {
    path = absolute[1] || '/';
  } else if (path.startsWith('//')) {
    const idx = path.indexOf('/', 2);
    path = idx === -1 ? '/' : path.slice(idx);
  } else if (!path.startsWith('/')) {
    const first = path.split('/')[0];
    const looksLikeHost = /\./.test(first.split(':')[0]);
    const isVariable = /^\{\{.*\}\}$/.test(first);
    if (looksLikeHost || isVariable) {
      const idx = path.indexOf('/');
      path = idx === -1 ? '/' : path.slice(idx);
    } else {
      path = '/' + path;
    }
  }
  return normalizePath(path);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile `:id` / `{id}` segments into a matcher. Both spellings are accepted
 * because imported collections use either.
 */
export function compileRoute(path) {
  const normalized = normalizePath(path);
  const segments = normalized === '/' ? [] : normalized.slice(1).split('/');
  const paramNames = [];
  let literalSegments = 0;
  const pattern = segments
    .map((segment) => {
      const param = /^:([^/]+)$/.exec(segment) || /^\{([^/]+)\}$/.exec(segment);
      if (param) {
        paramNames.push(param[1]);
        return '([^/]+)';
      }
      literalSegments += 1;
      return escapeRegex(segment);
    })
    .join('/');
  return {
    path: normalized,
    matcher: normalized === '/' ? /^\/$/ : new RegExp(`^/${pattern}/?$`),
    paramNames,
    literalSegments,
    segmentCount: segments.length,
    hasParams: paramNames.length > 0,
  };
}

export function compareRoutes(a, b) {
  // Exact paths win, then more literal segments, then deeper paths. The
  // original request order breaks ties deterministically.
  if (a.hasParams !== b.hasParams) return a.hasParams ? 1 : -1;
  if (a.literalSegments !== b.literalSegments) return b.literalSegments - a.literalSegments;
  if (a.segmentCount !== b.segmentCount) return b.segmentCount - a.segmentCount;
  return (a.order || 0) - (b.order || 0);
}

export function sortRoutes(routes) {
  return [...routes].sort(compareRoutes);
}

/** First method/path match from an already sorted route list. */
export function matchRoutes(routes, method, path) {
  const wanted = String(method || 'GET').toUpperCase();
  const normalized = normalizePath(path);
  for (const route of routes) {
    if (route.method !== wanted) continue;
    const match = route.matcher.exec(normalized);
    if (!match) continue;
    const params = {};
    route.paramNames.forEach((name, index) => {
      let value = match[index + 1];
      try {
        value = decodeURIComponent(value);
      } catch {
        /* keep the raw segment */
      }
      params[name] = value;
    });
    return { route, params };
  }
  return null;
}

// ---- Conditions ----

export function conditionNeedsBody(condition) {
  return condition?.source === 'body';
}

export function scenarioNeedsBody(scenario) {
  if (!scenario) return false;
  if (scenario.conditions.some((c) => c.enabled !== false && conditionNeedsBody(c))) return true;
  return /\{\{\s*request\.body\./.test(scenario.body || '');
}

export function configNeedsBody(config) {
  return (config?.scenarios || []).some(scenarioNeedsBody);
}

function nestedValue(value, dotPath) {
  let current = value;
  for (const part of String(dotPath || '').split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

export function getRequestValue(ctx, source, key) {
  const c = ctx || {};
  if (source === 'query') {
    if (c.query && typeof c.query.get === 'function') return c.query.get(key);
    return c.query?.[key];
  }
  if (source === 'header') {
    const headers = c.headers || {};
    const wanted = String(key).toLowerCase();
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === wanted) return value;
    }
    return undefined;
  }
  if (source === 'body') return nestedValue(c.body, key);
  if (source === 'path') return c.path?.[key];
  return undefined;
}

function isPresent(value) {
  return value !== undefined && value !== null && String(value) !== '';
}

function compareNumberOrString(actual, expected) {
  const a = String(actual);
  const e = String(expected);
  const an = a.trim() === '' ? NaN : Number(a);
  const en = e.trim() === '' ? NaN : Number(e);
  if (Number.isFinite(an) && Number.isFinite(en)) return an < en ? -1 : an > en ? 1 : 0;
  return a < e ? -1 : a > e ? 1 : 0;
}

export function evaluateCondition(condition, ctx) {
  if (!condition) return false;
  const actual = getRequestValue(ctx, condition.source, condition.key);
  const expected = String(condition.value ?? '');
  switch (condition.operator) {
    case 'equals':
      return String(actual ?? '') === expected;
    case 'not_equals':
      return String(actual ?? '') !== expected;
    case 'contains':
      return String(actual ?? '').includes(expected);
    case 'not_contains':
      return !String(actual ?? '').includes(expected);
    case 'exists':
      return isPresent(actual);
    case 'not_exists':
      return !isPresent(actual);
    case 'gt':
      return isPresent(actual) && compareNumberOrString(actual, expected) > 0;
    case 'lt':
      return isPresent(actual) && compareNumberOrString(actual, expected) < 0;
    default:
      return false;
  }
}

/** All enabled conditions must match. A scenario with no conditions never
 *  matches in auto mode (it can still be the default or manually selected). */
export function evaluateConditions(conditions, ctx) {
  const active = (conditions || []).filter(
    (c) => c && c.enabled !== false && c.key
  );
  if (active.length === 0) return false;
  return active.every((condition) => evaluateCondition(condition, ctx));
}

/**
 * Pick a scenario.
 * - manual: active id if valid, otherwise the default;
 * - auto: first condition match, otherwise the default.
 * Empty-condition scenarios are never auto-matched.
 */
export function selectScenario(config, ctx) {
  const m = normalizeMockConfig(config);
  const enabled = m.scenarios.filter((s) => s.enabled);
  if (!enabled.length) return null;
  const fallback = enabled.find((s) => s.isDefault) || null;

  if (m.mode === 'manual') {
    const active = enabled.find((s) => s.id === m.activeScenarioId);
    if (active) return { scenario: active, reason: 'manual' };
    return fallback ? { scenario: fallback, reason: 'default' } : null;
  }

  for (const scenario of enabled) {
    if (scenario.conditions.length > 0 && evaluateConditions(scenario.conditions, ctx)) {
      return { scenario, reason: 'condition' };
    }
  }
  return fallback ? { scenario: fallback, reason: 'default' } : null;
}

// ---- Templates ----

export function renderMockTemplate(text, ctx) {
  return String(text ?? '').replace(
    /\{\{\s*request\.(query|header|body|path)\.([\w.-]+)\s*\}\}/g,
    (_whole, source, key) => {
      const value = getRequestValue(ctx, source, key);
      if (value == null) return '';
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
  );
}
