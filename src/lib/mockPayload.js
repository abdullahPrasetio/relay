// Validation and canonicalisation for relay-api's server-side mock payloads.
//
// The renderer uses these builders before an IPC call, and the main-process
// cloud client uses the same builders before an HTTP call, so the two layers
// cannot drift. Server-side validation remains authoritative.

export const MOCK_METHODS = Object.freeze([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);

export const MOCK_MODES = Object.freeze(['auto', 'manual']);
export const MOCK_RESPONSE_TYPES = Object.freeze(['text', 'file']);
export const MOCK_CONDITION_SOURCES = Object.freeze(['query', 'header', 'body']);
export const MOCK_CONDITION_OPERATORS = Object.freeze([
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'exists',
  'not_exists',
  'regex',
  'gt',
  'lt',
]);

export const MOCK_LIMITS = Object.freeze({
  bodyBytes: 1 << 20,
  fileBytes: 2 << 20,
  delayMs: 10000,
  pathLength: 512,
  pathSegmentLength: 128,
  headers: 32,
  headerValueLength: 2048,
  conditions: 20,
  scenarios: 20,
  nameLength: 120,
  scenarioNameLength: 120,
  conditionKeyLength: 200,
  orderIndex: 10000,
});

const RESERVED_HEADERS = new Set([
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
]);

const HEADER_NAME = /^[A-Za-z0-9_-]+$/;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return value == null ? '' : String(value);
}

function utf8Length(value) {
  return new TextEncoder().encode(text(value)).length;
}

function integer(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number)) {
    throw new TypeError(`${field} must be an integer`);
  }
  return number;
}

function boundedInteger(value, field, min, max) {
  const number = integer(value, field);
  if (number < min || number > max) {
    throw new TypeError(`${field} must be between ${min} and ${max}`);
  }
  return number;
}

/** Canonical mock path: leading slash, no query/fragment, no duplicate slashes. */
export function normalizeMockPath(raw) {
  let path = text(raw).trim();
  const cut = path.search(/[?#]/);
  if (cut >= 0) path = path.slice(0, cut);
  if (!path) return '/';
  if (!path.startsWith('/')) path = `/${path}`;
  const segments = path.split('/').filter(Boolean);
  return segments.length ? `/${segments.join('/')}` : '/';
}

/** Turn a saved request URL into the path a generated mock will inherit. */
export function mockPathFromUrl(raw) {
  let value = text(raw).trim();
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      value = url.pathname || '/';
      try {
        value = decodeURIComponent(value);
      } catch {
        /* keep the encoded path when it is malformed */
      }
    } catch {
      /* fall through to the raw value */
    }
  }
  const cut = value.search(/[?#]/);
  if (cut >= 0) value = value.slice(0, cut);
  value = value.replaceAll('{{', '{').replaceAll('}}', '}');
  return normalizeMockPath(value);
}

export function normalizeMockMethod(value) {
  const method = text(value).trim().toUpperCase();
  if (!method) throw new TypeError('method is required');
  if (!MOCK_METHODS.includes(method)) {
    throw new TypeError(`method must be one of ${MOCK_METHODS.join(', ')}`);
  }
  return method;
}

export function validateMockPath(value) {
  const path = normalizeMockPath(value);
  if (path.length > MOCK_LIMITS.pathLength) {
    throw new TypeError(`path exceeds ${MOCK_LIMITS.pathLength} characters`);
  }
  for (const segment of path.replace(/^\/|\/$/g, '').split('/')) {
    if (!segment) continue;
    if (segment.length > MOCK_LIMITS.pathSegmentLength) {
      throw new TypeError(
        `path segment exceeds ${MOCK_LIMITS.pathSegmentLength} characters`
      );
    }
    if (/[ \t\r\n]/.test(segment)) {
      throw new TypeError('path segments cannot contain spaces');
    }
  }
  return path;
}

/** Normalise header editor rows (or an object) into relay-api's map shape. */
export function normalizeMockHeaders(source) {
  const entries = [];
  if (Array.isArray(source)) {
    for (const row of source) {
      if (!row || row.enabled === false) continue;
      const key = text(row.key).trim();
      if (!key) continue;
      entries.push([key, text(row.value)]);
    }
  } else if (isRecord(source)) {
    for (const [key, value] of Object.entries(source)) {
      if (!text(key).trim()) continue;
      entries.push([text(key).trim(), text(value)]);
    }
  } else if (source !== undefined && source !== null) {
    throw new TypeError('responseHeaders must be an array or object');
  }

  if (entries.length > MOCK_LIMITS.headers) {
    throw new TypeError(`at most ${MOCK_LIMITS.headers} response headers`);
  }

  const headers = {};
  for (const [key, value] of entries) {
    if (!HEADER_NAME.test(key)) {
      throw new TypeError(`header name "${key}" is not valid`);
    }
    if (RESERVED_HEADERS.has(key.toLowerCase())) {
      throw new TypeError(`header "${key}" is set by the server`);
    }
    if (/[\r\n]/.test(value)) {
      throw new TypeError(`header "${key}" contains a line break`);
    }
    if (value.length > MOCK_LIMITS.headerValueLength) {
      throw new TypeError(`header "${key}" value is too long`);
    }
    headers[key] = value;
  }
  return headers;
}

function validateBody(value) {
  const body = text(value);
  if (utf8Length(body) > MOCK_LIMITS.bodyBytes) {
    throw new TypeError(`responseBody exceeds ${MOCK_LIMITS.bodyBytes} bytes`);
  }
  return body;
}

function base64ByteLength(encoded) {
  const source = text(encoded).replace(/\s+/g, '');
  if (!source) return 0;
  const padding = source.endsWith('==') ? 2 : source.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((source.length * 3) / 4) - padding);
}

function validateConditions(source) {
  if (!Array.isArray(source)) throw new TypeError('conditions must be an array');
  if (source.length > MOCK_LIMITS.conditions) {
    throw new TypeError(`at most ${MOCK_LIMITS.conditions} conditions per scenario`);
  }
  return source.map((condition) => {
    if (!isRecord(condition)) throw new TypeError('each condition must be an object');
    const sourceName = text(condition.source).trim().toLowerCase();
    if (!MOCK_CONDITION_SOURCES.includes(sourceName)) {
      throw new TypeError('condition source must be query, header or body');
    }
    const operator = text(condition.operator).trim().toLowerCase();
    if (!MOCK_CONDITION_OPERATORS.includes(operator)) {
      throw new TypeError(`condition operator "${condition.operator}" is not supported`);
    }
    const key = text(condition.key).trim();
    if (!key) throw new TypeError('condition key is required');
    if (key.length > MOCK_LIMITS.conditionKeyLength) {
      throw new TypeError('condition key is too long');
    }
    const value = text(condition.value);
    if (value.length > MOCK_LIMITS.headerValueLength) {
      throw new TypeError('condition value is too long');
    }
    if (operator === 'regex') {
      try {
        new RegExp(value);
      } catch {
        throw new TypeError(`condition regex "${value}" does not compile`);
      }
    }
    return { source: sourceName, key, operator, value };
  });
}

function validateFile(fileName, fileBase64) {
  const name = text(fileName).trim();
  if (!name) throw new TypeError('fileName is required for a file response');
  if (
    name.length > 200 ||
    /[/\\\r\n]/.test(name) ||
    name === '.' ||
    name === '..'
  ) {
    throw new TypeError('fileName must be a plain file name');
  }
  const encoded = text(fileBase64).trim();
  if (!encoded) throw new TypeError('fileBase64 is required for a file response');
  if (base64ByteLength(encoded) > MOCK_LIMITS.fileBytes) {
    throw new TypeError(`file exceeds ${MOCK_LIMITS.fileBytes} bytes`);
  }
  return { fileName: name, fileBase64: encoded };
}

/**
 * Build a create/update body for `/mocks`. `partial` emits only supplied
 * fields so a PATCH never resets unrelated endpoint settings.
 */
export function buildMockPayload(input = {}, { partial = false } = {}) {
  if (!isRecord(input)) throw new TypeError('mock payload must be an object');
  const out = {};
  const has = (key) => input[key] !== undefined;

  if (!partial || has('name')) {
    const name = text(input.name).trim();
    if (name.length > MOCK_LIMITS.nameLength) {
      throw new TypeError(`name exceeds ${MOCK_LIMITS.nameLength} characters`);
    }
    if (partial || name) out.name = name;
  }
  if (!partial || has('method')) out.method = normalizeMockMethod(input.method);
  if (!partial || has('path')) out.path = validateMockPath(input.path);
  if (has('statusCode')) {
    out.statusCode = boundedInteger(input.statusCode, 'statusCode', 100, 599);
  }
  if (has('responseHeaders')) {
    out.responseHeaders = normalizeMockHeaders(input.responseHeaders);
  }
  if (has('responseBody')) out.responseBody = validateBody(input.responseBody);
  if (has('delayMs')) {
    out.delayMs = boundedInteger(input.delayMs, 'delayMs', 0, MOCK_LIMITS.delayMs);
  }
  if (has('delayMaxMs')) {
    out.delayMaxMs = boundedInteger(input.delayMaxMs, 'delayMaxMs', 0, MOCK_LIMITS.delayMs);
    const min = has('delayMs') ? Number(input.delayMs) : 0;
    if (out.delayMaxMs !== 0 && out.delayMaxMs < min) {
      throw new TypeError('delayMaxMs must be 0 or at least delayMs');
    }
  }
  if (has('errorRate')) {
    out.errorRate = boundedInteger(input.errorRate, 'errorRate', 0, 100);
  }
  if (has('errorStatusCode')) {
    out.errorStatusCode = boundedInteger(input.errorStatusCode, 'errorStatusCode', 400, 599);
  }
  if (has('enabled')) {
    if (typeof input.enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
    out.enabled = input.enabled;
  }
  if (has('evaluationMode')) {
    const mode = text(input.evaluationMode).trim();
    if (!MOCK_MODES.includes(mode)) {
      throw new TypeError(`evaluationMode must be ${MOCK_MODES.join(' or ')}`);
    }
    out.evaluationMode = mode;
  }
  if (has('activeScenarioId')) {
    if (input.activeScenarioId !== null && typeof input.activeScenarioId !== 'string') {
      throw new TypeError('activeScenarioId must be a string or null');
    }
    out.activeScenarioId = input.activeScenarioId;
  }
  return out;
}

/** The `/mocks/from-*` routes accept a narrower override body. */
export function buildMockOverridePayload(input = {}) {
  const payload = buildMockPayload(input, { partial: true });
  for (const key of ['enabled', 'evaluationMode', 'activeScenarioId']) delete payload[key];
  return payload;
}

/** Build a create/update body for `/mocks/:id/scenarios`. */
export function buildScenarioPayload(input = {}, { partial = false } = {}) {
  if (!isRecord(input)) throw new TypeError('scenario payload must be an object');
  const out = {};
  const has = (key) => input[key] !== undefined;

  if (!partial || has('name')) {
    const name = text(input.name).trim();
    if (!name || name.length > MOCK_LIMITS.scenarioNameLength) {
      throw new TypeError(
        `scenario name must be 1-${MOCK_LIMITS.scenarioNameLength} characters`
      );
    }
    out.name = name;
  }
  if (has('statusCode')) {
    out.statusCode = boundedInteger(input.statusCode, 'statusCode', 100, 599);
  }
  if (has('responseHeaders')) {
    out.responseHeaders = normalizeMockHeaders(input.responseHeaders);
  }
  if (has('responseBody')) out.responseBody = validateBody(input.responseBody);
  if (has('responseType')) {
    const kind = text(input.responseType).trim().toLowerCase();
    if (!MOCK_RESPONSE_TYPES.includes(kind)) {
      throw new TypeError(`responseType must be ${MOCK_RESPONSE_TYPES.join(' or ')}`);
    }
    out.responseType = kind;
    if (kind === 'file') {
      Object.assign(out, validateFile(input.fileName, input.fileBase64));
    } else {
      out.fileName = '';
      out.fileBase64 = '';
    }
  } else if (has('fileName') || has('fileBase64')) {
    Object.assign(out, validateFile(input.fileName, input.fileBase64));
  }
  if (has('conditions')) out.conditions = validateConditions(input.conditions);
  if (has('isDefault')) {
    if (typeof input.isDefault !== 'boolean') {
      throw new TypeError('isDefault must be a boolean');
    }
    out.isDefault = input.isDefault;
  }
  if (has('orderIndex')) {
    out.orderIndex = boundedInteger(input.orderIndex, 'orderIndex', 0, MOCK_LIMITS.orderIndex);
  }
  return out;
}
