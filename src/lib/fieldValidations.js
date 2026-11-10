// Field-level documentation metadata for a request.
//
// Rules are descriptive, not enforcement: they tell readers what a field
// requires (and give it a human description) in exported HTML/Confluence
// docs. The mock server's scenario conditions remain the runtime matcher.
import { pathnameOf } from '../../shared/mockScenarios.js';

export const VALIDATION_SECTIONS = ['path', 'params', 'headers', 'body'];

export const SECTION_LABELS = {
  path: 'Path variables',
  params: 'Query parameters',
  headers: 'Headers',
  body: 'Body fields',
};

// Keep this list aligned with Wapbolt's Validation tab. The order is also the
// display order, so configs normalized from any source look the same.
export const VALIDATION_RULES = [
  'required',
  'nullable',
  'string',
  'integer',
  'numeric',
  'boolean',
  'email',
  'url',
  'array',
  'object',
  'unique',
];

export function emptyValidationRule() {
  return { rules: [], min: 0, max: 0, description: '' };
}

function str(value) {
  return value == null ? '' : String(value);
}

function boundedInt(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(n)));
}

/** Normalize one rule, dropping unknown/duplicate rules and empty fields. */
// Wapbolt also accepts custom tokens such as "max:100"; keep those when
// imported, but reject arbitrary text so a typo cannot become a fake rule.
const CUSTOM_RULE_RE = /^[a-z][a-z0-9_-]*(?::[a-z0-9._-]+)?$/;

export function normalizeValidationRule(raw) {
  const rule = raw && typeof raw === 'object' ? raw : {};
  const supplied = [];
  for (const value of Array.isArray(rule.rules) ? rule.rules : []) {
    const token = str(value).trim().toLowerCase();
    if (!token || supplied.includes(token)) continue;
    if (VALIDATION_RULES.includes(token) || CUSTOM_RULE_RE.test(token)) supplied.push(token);
  }
  const known = VALIDATION_RULES.filter((value) => supplied.includes(value));
  const custom = supplied.filter((value) => !VALIDATION_RULES.includes(value));
  return {
    // Known rules first, then imported custom tokens in input order.
    rules: [...known, ...custom],
    min: boundedInt(rule.min),
    max: boundedInt(rule.max),
    description: str(rule.description),
  };
}

export function hasValidation(rule) {
  if (!rule) return false;
  return (
    (Array.isArray(rule.rules) && rule.rules.length > 0) ||
    Number(rule.min) > 0 ||
    Number(rule.max) > 0 ||
    str(rule.description).trim() !== ''
  );
}

/**
 * Normalize the whole map. Sections without a valid field key and rules with
 * no content are omitted, so a cleared editor does not leave debris behind.
 */
export function normalizeFieldValidations(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const section of VALIDATION_SECTIONS) {
    out[section] = {};
    const fields = src[section];
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) continue;
    for (const [rawKey, rawRule] of Object.entries(fields)) {
      const key = str(rawKey);
      if (!key.trim()) continue;
      const rule = normalizeValidationRule(rawRule);
      if (hasValidation(rule)) out[section][key] = rule;
    }
  }
  return out;
}

/** True when at least one field has validation metadata. */
export function hasFieldValidations(raw) {
  const normalized = normalizeFieldValidations(raw);
  return VALIDATION_SECTIONS.some((section) => Object.keys(normalized[section]).length > 0);
}

/** Count fields that carry any metadata. */
export function countValidatedFields(raw) {
  const normalized = normalizeFieldValidations(raw);
  return VALIDATION_SECTIONS.reduce(
    (total, section) => total + Object.keys(normalized[section]).length,
    0
  );
}

/** Human-readable badges for docs and tooltips. */
export function validationTokens(rule) {
  if (!hasValidation(rule)) return [];
  const tokens = (rule.rules || []).map((value) => String(value).toUpperCase());
  if (Number(rule.min) > 0) tokens.push(`MIN ${rule.min}`);
  if (Number(rule.max) > 0) tokens.push(`MAX ${rule.max}`);
  return tokens;
}

// ---- Field discovery ----

function enabledRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.key && row.enabled !== false)
    .map((row) => ({
      key: str(row.key),
      value: row.value == null ? '' : String(row.value),
    }));
}

/**
 * Flatten an object into dot-path leaves. Arrays and scalars are values; an
 * empty object stays visible as `{}` so it can still be documented.
 */
export function flattenBodyValue(value, prefix = '', out = []) {
  if (Array.isArray(value)) {
    if (prefix) out.push({ key: prefix, value: JSON.stringify(value) });
    return out;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0 && prefix) {
      out.push({ key: prefix, value: '{}' });
      return out;
    }
    for (const [key, child] of entries) {
      flattenBodyValue(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }
  if (prefix) out.push({ key: prefix, value: value == null ? 'null' : String(value) });
  return out;
}

function parsedObject(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Body rows that can be documented/validated, matching the body mode. */
export function bodyValidationFields(body) {
  const mode = body?.mode || 'none';
  if (mode === 'form-urlencoded' || mode === 'form-data') {
    return enabledRows(body?.form);
  }
  if (mode === 'json' || mode === 'raw') {
    const parsed = parsedObject(body?.raw);
    return parsed ? flattenBodyValue(parsed) : [];
  }
  if (mode === 'graphql') {
    const parsed = parsedObject(body?.graphql?.variables);
    return parsed ? flattenBodyValue(parsed) : [];
  }
  return [];
}

function pathVarNames(url) {
  // Only inspect the pathname: `{{baseUrl}}` is a host variable, not a path
  // parameter, and query values can contain braces too.
  const path = pathnameOf(url);
  const names = [];
  for (const match of path.matchAll(/(?:^|\/):([A-Za-z_]\w*)/g)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  for (const match of path.matchAll(/\{([A-Za-z_]\w*)\}/g)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

/** Path rows, including names from the URL that have no stored value yet. */
export function pathValidationFields(request) {
  const rows = Array.isArray(request?.pathVars) ? request.pathVars : [];
  return pathVarNames(request?.url).map((name) => {
    const row = rows.find((candidate) => candidate && String(candidate.key) === String(name));
    return {
      key: String(name),
      value: row && row.value != null ? String(row.value) : '',
    };
  });
}

/**
 * All fields the request currently exposes, grouped by validation section.
 * Disabled params/headers/form rows are ignored, matching what docs show.
 */
export function collectValidationFields(request) {
  return {
    path: pathValidationFields(request),
    params: enabledRows(request?.params),
    headers: enabledRows(request?.headers),
    body: bodyValidationFields(request?.body),
  };
}
