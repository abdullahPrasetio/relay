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
  return {
    rules: [],
    min: 0,
    max: 0,
    minLength: null,
    maxLength: null,
    minimum: null,
    maximum: null,
    minItems: null,
    maxItems: null,
    pattern: '',
    format: '',
    enum: [],
    example: '',
    default: '',
    description: '',
  };
}

function str(value) {
  return value == null ? '' : String(value);
}

function boundedInt(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(n)));
}

function optionalInt(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(n)));
}

function optionalNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function enumValues(value) {
  const source = Array.isArray(value) ? value : [];
  const out = [];
  for (const entry of source) {
    const text = str(entry).trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
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
    minLength: optionalInt(rule.minLength),
    maxLength: optionalInt(rule.maxLength),
    minimum: optionalNumber(rule.minimum),
    maximum: optionalNumber(rule.maximum),
    minItems: optionalInt(rule.minItems),
    maxItems: optionalInt(rule.maxItems),
    pattern: str(rule.pattern).trim(),
    format: str(rule.format).trim().toLowerCase(),
    enum: enumValues(rule.enum),
    example: str(rule.example),
    default: str(rule.default),
    description: str(rule.description),
  };
}

export function isValidPattern(pattern) {
  const text = str(pattern).trim();
  if (!text) return true;
  try {
    // Compile only; matching is done by the consumer.
    new RegExp(text);
    return true;
  } catch {
    return false;
  }
}

export function hasValidation(rule) {
  if (!rule) return false;
  return (
    (Array.isArray(rule.rules) && rule.rules.length > 0) ||
    Number(rule.min) > 0 ||
    Number(rule.max) > 0 ||
    rule.minLength != null ||
    rule.maxLength != null ||
    rule.minimum != null ||
    rule.maximum != null ||
    rule.minItems != null ||
    rule.maxItems != null ||
    str(rule.pattern).trim() !== '' ||
    str(rule.format).trim() !== '' ||
    (Array.isArray(rule.enum) && rule.enum.length > 0) ||
    str(rule.example).trim() !== '' ||
    str(rule.default).trim() !== '' ||
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

/** Min/max labels depend on the primary type rule. */
export function minMaxLabels(rule) {
  const rules = Array.isArray(rule?.rules) ? rule.rules : [];
  if (rules.includes('integer') || rules.includes('numeric')) {
    return { min: 'Min value', max: 'Max value' };
  }
  if (rules.includes('array')) return { min: 'Min items', max: 'Max items' };
  if (rules.includes('string') || rules.includes('email') || rules.includes('url')) {
    return { min: 'Min length', max: 'Max length' };
  }
  return { min: 'Min', max: 'Max' };
}

/** Human-readable badges for docs and tooltips. */
export function validationTokens(rule) {
  if (!hasValidation(rule)) return [];
  const tokens = (rule.rules || []).map((value) => String(value).toUpperCase());
  if (Number(rule.min) > 0) tokens.push(`MIN ${rule.min}`);
  if (Number(rule.max) > 0) tokens.push(`MAX ${rule.max}`);
  if (rule.minLength != null) tokens.push(`MIN LENGTH ${rule.minLength}`);
  if (rule.maxLength != null) tokens.push(`MAX LENGTH ${rule.maxLength}`);
  if (rule.minimum != null) tokens.push(`MIN VALUE ${rule.minimum}`);
  if (rule.maximum != null) tokens.push(`MAX VALUE ${rule.maximum}`);
  if (rule.minItems != null) tokens.push(`MIN ITEMS ${rule.minItems}`);
  if (rule.maxItems != null) tokens.push(`MAX ITEMS ${rule.maxItems}`);
  if (str(rule.pattern).trim()) tokens.push('PATTERN');
  if (str(rule.format).trim()) tokens.push(`FORMAT ${String(rule.format).toUpperCase()}`);
  if (Array.isArray(rule.enum) && rule.enum.length > 0) tokens.push(`ENUM ${rule.enum.length}`);
  if (str(rule.example).trim()) tokens.push('EXAMPLE');
  if (str(rule.default).trim()) tokens.push('DEFAULT');
  return tokens;
}

export const RESPONSE_VALIDATION_SECTIONS = ['body', 'headers'];

function normalizeSections(raw, sections) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const section of sections) {
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

export function normalizeResponseValidations(raw) {
  return normalizeSections(raw, RESPONSE_VALIDATION_SECTIONS);
}

export function hasResponseValidations(raw) {
  const normalized = normalizeResponseValidations(raw);
  return RESPONSE_VALIDATION_SECTIONS.some(
    (section) => Object.keys(normalized[section]).length > 0
  );
}

export function countResponseValidatedFields(raw) {
  const normalized = normalizeResponseValidations(raw);
  return RESPONSE_VALIDATION_SECTIONS.reduce(
    (total, section) => total + Object.keys(normalized[section]).length,
    0
  );
}

function latestResponseExample(request) {
  const examples = Array.isArray(request?.examples) ? request.examples.filter(Boolean) : [];
  return examples.length ? examples[examples.length - 1] : null;
}

export function responseValidationFields(request) {
  const response = latestResponseExample(request)?.response || {};
  const parsed = parsedObject(response.body);
  const body = parsed ? flattenBodyValue(parsed) : [];
  const headers = enabledRows(response.headers);
  const validations = normalizeResponseValidations(request?.responseValidations);
  const bodyKeys = new Set(body.map((field) => field.key));
  const headerKeys = new Set(headers.map((field) => field.key));
  for (const key of Object.keys(validations.body)) {
    if (!bodyKeys.has(key)) body.push({ key, value: '' });
  }
  for (const key of Object.keys(validations.headers)) {
    if (!headerKeys.has(key)) headers.push({ key, value: '' });
  }
  return { body, headers };
}

// ---- Inheritance ----

// A child rule overrides the keys it defines but keeps inherited ones it does
// not mention, so a folder can add a description without losing a required
// rule from its collection.
export function mergeValidationRule(parent, child) {
  if (!parent) return child ? { ...child } : parent;
  if (!child) return { ...parent };
  const merged = { ...parent };
  if (Array.isArray(child.rules) && child.rules.length > 0) merged.rules = [...child.rules];
  for (const key of ['min', 'max']) {
    if (Number(child[key]) > 0) merged[key] = child[key];
  }
  for (const key of [
    'minLength',
    'maxLength',
    'minimum',
    'maximum',
    'minItems',
    'maxItems',
  ]) {
    if (child[key] != null) merged[key] = child[key];
  }
  for (const key of ['pattern', 'format', 'example', 'default', 'description']) {
    if (child[key]) merged[key] = child[key];
  }
  if (Array.isArray(child.enum) && child.enum.length > 0) merged.enum = [...child.enum];
  return merged;
}

function mergeValidationSection(parent = {}, child = {}) {
  const out = { ...parent };
  for (const [key, rule] of Object.entries(child || {})) {
    out[key] = mergeValidationRule(parent[key], rule);
  }
  return out;
}

export function mergeFieldValidations(...maps) {
  const out = normalizeFieldValidations({});
  for (const map of maps) {
    const normalized = normalizeFieldValidations(map);
    for (const section of VALIDATION_SECTIONS) {
      out[section] = mergeValidationSection(out[section], normalized[section]);
    }
  }
  return out;
}

export function mergeResponseValidations(...maps) {
  const out = normalizeResponseValidations({});
  for (const map of maps) {
    const normalized = normalizeResponseValidations(map);
    for (const section of RESPONSE_VALIDATION_SECTIONS) {
      out[section] = mergeValidationSection(out[section], normalized[section]);
    }
  }
  return out;
}

// Resolve collection -> folder -> ... -> request. `ancestors` is the path from
// `findNodePath`: [collection, ...folders], outermost first.
export function resolveRequestValidations(request, ancestors = []) {
  const fieldMaps = [];
  const responseMaps = [];
  for (const node of ancestors || []) {
    if (!node) continue;
    fieldMaps.push(node.fieldValidations);
    responseMaps.push(node.responseValidations);
  }
  fieldMaps.push(request?.fieldValidations);
  responseMaps.push(request?.responseValidations);
  return {
    fieldValidations: mergeFieldValidations(...fieldMaps),
    responseValidations: mergeResponseValidations(...responseMaps),
  };
}

// Union of fields used by every request below a collection or folder. Used by
// the collection/folder validation editors so they can offer the same field
// names that requests already expose.
export function collectContainerValidationFields(container) {
  const fields = { path: [], params: [], headers: [], body: [] };
  const responseFields = { body: [], headers: [] };
  const seen = {
    path: new Set(),
    params: new Set(),
    headers: new Set(),
    body: new Set(),
    responseBody: new Set(),
    responseHeaders: new Set(),
  };
  const add = (list, set, field) => {
    if (!field?.key || set.has(field.key)) return;
    set.add(field.key);
    list.push(field);
  };
  const addRuleKeys = (list, set, rules) => {
    for (const key of Object.keys(rules || {})) add(list, set, { key, value: '' });
  };
  addRuleKeys(fields.path, seen.path, container?.fieldValidations?.path);
  addRuleKeys(fields.params, seen.params, container?.fieldValidations?.params);
  addRuleKeys(fields.headers, seen.headers, container?.fieldValidations?.headers);
  addRuleKeys(fields.body, seen.body, container?.fieldValidations?.body);
  addRuleKeys(responseFields.body, seen.responseBody, container?.responseValidations?.body);
  addRuleKeys(responseFields.headers, seen.responseHeaders, container?.responseValidations?.headers);

  const walk = (items) => {
    for (const node of Array.isArray(items) ? items : []) {
      if (!node) continue;
      if (node.type === 'folder') {
        addRuleKeys(fields.path, seen.path, node.fieldValidations?.path);
        addRuleKeys(fields.params, seen.params, node.fieldValidations?.params);
        addRuleKeys(fields.headers, seen.headers, node.fieldValidations?.headers);
        addRuleKeys(fields.body, seen.body, node.fieldValidations?.body);
        addRuleKeys(responseFields.body, seen.responseBody, node.responseValidations?.body);
        addRuleKeys(responseFields.headers, seen.responseHeaders, node.responseValidations?.headers);
        walk(node.items);
        continue;
      }
      const requestFields = collectValidationFields(node);
      for (const section of VALIDATION_SECTIONS) {
        for (const field of requestFields[section]) add(fields[section], seen[section], field);
      }
      const requestResponseFields = responseValidationFields(node);
      for (const field of requestResponseFields.body) add(responseFields.body, seen.responseBody, field);
      for (const field of requestResponseFields.headers) {
        add(responseFields.headers, seen.responseHeaders, field);
      }
    }
  };
  walk(container?.items);
  return { fields, responseFields };
}

// ---- Field discovery ----

function enabledRows(rows, { fileAware = false } = {}) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.key && row.enabled !== false)
    .map((row) => ({
      key: str(row.key),
      value:
        fileAware && row.type === 'file'
          ? str(row.fileName || row.filePath || 'file')
          : row.value == null
            ? ''
            : String(row.value),
    }));
}

/**
 * Flatten an object into dot-path leaves. Arrays and scalars are values; an
 * empty object stays visible as `{}` so it can still be documented.
 */
export function flattenBodyValue(value, prefix = '', out = []) {
  if (Array.isArray(value)) {
    const arrayKey = `${prefix || ''}[]`;
    if (prefix) out.push({ key: arrayKey, value: JSON.stringify(value) });
    for (const item of value) {
      if (item && typeof item === 'object') {
        flattenBodyValue(item, arrayKey, out);
      }
    }
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
    return enabledRows(body?.form, { fileAware: mode === 'form-data' });
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
