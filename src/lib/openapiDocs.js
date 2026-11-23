// OpenAPI 3.0 generation for a Relay collection.
//
// Pure module: no DOM, Electron or network. The Confluence sync renders this
// spec as raw JSON or embeds it in the Swagger UI macro. Only enabled fields
// are emitted; credentials (Authorization/Cookie headers) are never included.

import {
  normalizeFieldValidations,
  isValidPattern,
  normalizeResponseValidations,
  resolveRequestValidations,
} from './fieldValidations.js';

const BODY_METHODS = new Set(['post', 'put', 'patch', 'delete']);

const STATUS_TEXT = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  410: 'Gone',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

const SECRET_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
]);

function isEnabled(row) {
  return !!row && row.enabled !== false;
}

function rows(collection) {
  return Array.isArray(collection) ? collection.filter(isEnabled) : [];
}

function parseJson(text) {
  if (typeof text !== 'string' || !text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'object';
  return typeof value === 'object' ? 'object' : typeof value === 'string' ? 'string' : typeof value;
}

function schemaForRule(rule, fallback = 'string') {
  if (!rule) return { type: fallback };
  const rules = Array.isArray(rule.rules) ? rule.rules : [];
  const type = rules.includes('integer')
    ? 'integer'
    : rules.includes('numeric')
      ? 'number'
      : rules.includes('boolean')
        ? 'boolean'
        : rules.includes('array')
          ? 'array'
          : rules.includes('object')
            ? 'object'
            : 'string';
  const schema = { type };
  if (rules.includes('nullable')) schema.nullable = true;
  if (rules.includes('unique') && type === 'array') schema.uniqueItems = true;
  if (rule.pattern && isValidPattern(rule.pattern)) schema.pattern = rule.pattern;
  if (rule.format) schema.format = rule.format;
  else if (rules.includes('email')) schema.format = 'email';
  else if (rules.includes('url')) schema.format = 'uri';
  if (Array.isArray(rule.enum) && rule.enum.length) schema.enum = rule.enum;
  if (rule.example) schema.example = rule.example;
  if (rule.default) schema.default = rule.default;
  if (type === 'integer' || type === 'number') {
    const min = rule.minimum != null ? rule.minimum : Number(rule.min) > 0 ? Number(rule.min) : null;
    const max = rule.maximum != null ? rule.maximum : Number(rule.max) > 0 ? Number(rule.max) : null;
    if (min != null) schema.minimum = min;
    if (max != null) schema.maximum = max;
  } else if (type === 'array') {
    const min = rule.minItems != null ? rule.minItems : Number(rule.min) > 0 ? Number(rule.min) : null;
    const max = rule.maxItems != null ? rule.maxItems : Number(rule.max) > 0 ? Number(rule.max) : null;
    if (min != null) schema.minItems = min;
    if (max != null) schema.maxItems = max;
  } else {
    const min = rule.minLength != null ? rule.minLength : Number(rule.min) > 0 ? Number(rule.min) : null;
    const max = rule.maxLength != null ? rule.maxLength : Number(rule.max) > 0 ? Number(rule.max) : null;
    if (min != null) schema.minLength = min;
    if (max != null) schema.maxLength = max;
  }
  return schema;
}

function schemaFromExample(value) {
  if (Array.isArray(value)) {
    return { type: 'array', items: value.length ? schemaFromExample(value[0]) : {} };
  }
  if (value && typeof value === 'object') {
    const properties = {};
    for (const [key, child] of Object.entries(value)) {
      properties[key] = schemaFromExample(child);
    }
    return { type: 'object', properties };
  }
  if (typeof value === 'number') {
    return { type: Number.isInteger(value) ? 'integer' : 'number', example: value };
  }
  if (typeof value === 'boolean') return { type: 'boolean', example: value };
  if (value === null) return { type: 'object', nullable: true };
  return { type: 'string', example: value };
}

function applyBodyValidations(schema, validations) {
  const entries = Object.entries(validations || {});
  if (entries.length === 0 || schema.type !== 'object') return schema;

  function ensureObject(node) {
    if (!node.properties) node.properties = {};
    return node;
  }

  for (const [path, rule] of entries) {
    const parts = String(path).split('.').filter(Boolean);
    if (!parts.length) continue;
    let parent = schema;
    let target = null;

    for (let i = 0; i < parts.length; i += 1) {
      const raw = parts[i];
      const isArray = raw.endsWith('[]');
      const name = isArray ? raw.slice(0, -2) : raw;
      if (!name) continue;
      ensureObject(parent);
      if (isArray) {
        parent.properties[name] = parent.properties[name] || {
          type: 'array',
          items: { type: 'object', properties: {} },
        };
        const arraySchema = parent.properties[name];
        if (i === parts.length - 1) {
          target = arraySchema;
          break;
        }
        arraySchema.items = arraySchema.items || { type: 'object', properties: {} };
        parent = ensureObject(arraySchema.items);
      } else {
        parent.properties[name] = parent.properties[name] || { type: 'object', properties: {} };
        if (i === parts.length - 1) {
          target = parent.properties[name];
          break;
        }
        parent = ensureObject(parent.properties[name]);
      }
    }

    if (!target) continue;
    const existingType = target.type || 'string';
    Object.assign(target, schemaForRule(rule, existingType));
    if ((rule.rules || []).includes('required')) {
      parent.required = parent.required || [];
      const leaf = parts[parts.length - 1].replace(/\[\]$/, '');
      if (!parent.required.includes(leaf)) parent.required.push(leaf);
    }
  }
  return schema;
}

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Convert a request URL into an OpenAPI path: strip origin/query, then turn
// `{{var}}` and `:var` into `{var}`.
export function requestPath(url) {
  let raw = String(url || '').trim();
  raw = raw.split('#')[0].split('?')[0];
  let path = raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      path = new URL(raw.replace(/\{\{[^}]+\}\}/g, 'var')).pathname;
    } catch {
      const rest = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
      const slash = rest.indexOf('/');
      path = slash >= 0 ? rest.slice(slash) : '/';
    }
  } else if (!raw.startsWith('/')) {
    const slash = raw.indexOf('/');
    path = slash >= 0 ? raw.slice(slash) : '/';
  }
  path = path
    .replace(/\{\{\s*([^}]+?)\s*\}\}/g, '{$1}')
    .replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  return path.startsWith('/') ? path || '/' : `/${path}`;
}

function bodyContent(body, validations = {}) {
  if (!body || body.mode === 'none') return null;
  if (body.mode === 'json' || body.mode === 'raw') {
    const raw = String(body.raw || '');
    if (!raw.trim()) return null;
    const parsed = parseJson(raw);
    const value = parsed === undefined ? raw : parsed;
    const schema = parsed === undefined
      ? { type: 'string', example: value }
      : applyBodyValidations({ ...schemaFromExample(value), example: value }, validations);
    return {
      mediaType: parsed === undefined ? 'text/plain' : 'application/json',
      example: value,
      schema,
    };
  }
  if (body.mode === 'form-urlencoded' || body.mode === 'form-data') {
    const example = {};
    for (const row of rows(body.form)) {
      if (row.key) example[row.key] = row.value ?? '';
    }
    if (Object.keys(example).length === 0) return null;
    const schema = applyBodyValidations(
      { ...schemaFromExample(example), example },
      validations
    );
    return {
      mediaType:
        body.mode === 'form-data' ? 'multipart/form-data' : 'application/x-www-form-urlencoded',
      example,
      schema,
    };
  }
  if (body.mode === 'graphql') {
    const query = String(body.graphql?.query || '').trim();
    if (!query) return null;
    const variables = parseJson(body.graphql?.variables);
    const example = variables === undefined ? { query } : { query, variables };
    return {
      mediaType: 'application/json',
      example,
      schema: applyBodyValidations({ ...schemaFromExample(example), example }, validations),
    };
  }
  return null;
}

function requestParameters(request, path, fieldValidations = null) {
  const params = [];
  const validations = fieldValidations || normalizeFieldValidations(request?.fieldValidations);
  const pathVars = new Map(
    rows(request.pathVars)
      .filter((row) => row.key)
      .map((row) => [row.key, row.value ?? ''])
  );
  for (const match of String(path).matchAll(/\{([^}]+)\}/g)) {
    const name = match[1];
    const rule = validations.path[name];
    const parameter = {
      name,
      in: 'path',
      required: true,
      schema: schemaForRule(rule, 'string'),
    };
    if (pathVars.has(name)) parameter.example = pathVars.get(name);
    if (rule?.description) parameter.description = rule.description;
    params.push(parameter);
  }

  for (const row of rows(request.params)) {
    if (!row.key) continue;
    const rule = validations.params[row.key];
    const parameter = {
      name: row.key,
      in: 'query',
      required: (rule?.rules || []).includes('required'),
      schema: schemaForRule(rule, 'string'),
    };
    if (row.value !== undefined) parameter.example = rule?.example || row.value;
    if (rule?.description) parameter.description = rule.description;
    params.push(parameter);
  }

  for (const row of rows(request.headers)) {
    const name = String(row.key || '').trim();
    if (!name || SECRET_HEADERS.has(name.toLowerCase())) continue;
    const rule = validations.headers[name];
    const parameter = {
      name,
      in: 'header',
      required: (rule?.rules || []).includes('required'),
      schema: schemaForRule(rule, 'string'),
    };
    if (row.value !== undefined) parameter.example = rule?.example || row.value;
    if (rule?.description) parameter.description = rule.description;
    params.push(parameter);
  }
  return params;
}

function exampleResponse(example, index, responseValidations = {}) {
  const response = example?.response || {};
  const status = Number(response.status) || 200;
  const statusKey = String(status);
  const body = response.body == null ? '' : String(response.body);
  const contentType = String(response.contentType || '').toLowerCase();
  const parsed = parseJson(body);
  const isJson = contentType.includes('json') || parsed !== undefined;
  const mediaType = isJson ? 'application/json' : contentType.split(';')[0] || 'text/plain';

  const result = {
    description: response.statusText || STATUS_TEXT[status] || 'Response',
  };
  if (body) {
    result.content = {
      [mediaType]: {
        schema: isJson && parsed !== undefined
          ? applyBodyValidations(
              { ...schemaFromExample(parsed), example: parsed },
              responseValidations.body || {}
            )
          : { type: 'string' },
        examples: {
          [example?.name || `example_${index + 1}`]: {
            value: isJson && parsed !== undefined ? parsed : body,
          },
        },
      },
    };
  }
  const headers = {};
  for (const row of rows(response.headers)) {
    if (!row.key) continue;
    const rule = responseValidations.headers?.[row.key];
    headers[row.key] = {
      schema: schemaForRule(rule, 'string'),
      ...(row.value !== undefined ? { example: rule?.example || row.value } : {}),
    };
  }
  if (Object.keys(headers).length > 0) result.headers = headers;
  return { statusKey, result };
}

function responsesFor(request, resolvedResponseValidations = null) {
  const examples = Array.isArray(request.examples) ? request.examples.filter(Boolean) : [];
  const responseValidations = resolvedResponseValidations || normalizeResponseValidations(request.responseValidations);
  if (examples.length === 0) {
    if (Object.keys(responseValidations.body).length === 0 && Object.keys(responseValidations.headers).length === 0) {
      return { 200: { description: 'Success' } };
    }
    const result = { description: 'Success' };
    if (Object.keys(responseValidations.body).length > 0) {
      result.content = {
        'application/json': {
          schema: applyBodyValidations(
            { type: 'object', properties: {} },
            responseValidations.body
          ),
        },
      };
    }
    if (Object.keys(responseValidations.headers).length > 0) {
      result.headers = Object.fromEntries(
        Object.entries(responseValidations.headers).map(([name, rule]) => [
          name,
          { schema: schemaForRule(rule, 'string') },
        ])
      );
    }
    return { 200: result };
  }
  const responses = {};
  examples.forEach((example, index) => {
    const { statusKey, result } = exampleResponse(example, index, responseValidations);
    const existing = responses[statusKey];
    if (!existing) {
      responses[statusKey] = result;
      return;
    }
    if (result.content) {
      existing.content = existing.content || {};
      for (const [mediaType, media] of Object.entries(result.content)) {
        const target = existing.content[mediaType] || { schema: media.schema, examples: {} };
        Object.assign(target.examples, media.examples);
        existing.content[mediaType] = target;
      }
    }
    if (result.headers) {
      existing.headers = { ...(existing.headers || {}), ...result.headers };
    }
  });
  return responses;
}

function walk(items, tag, visit, ancestors = []) {
  for (const node of Array.isArray(items) ? items : []) {
    if (!node) continue;
    if (node.type === 'folder') {
      walk(node.items, node.name || tag, visit, [...ancestors, node]);
      continue;
    }
    visit(node, tag, ancestors);
  }
}

/**
 * Build an OpenAPI 3.0.3 document for a collection.
 *
 * @param {object} collection
 * @param {{version?: string}} [options]
 * @returns {object}
 */
export function collectionToOpenApi(collection, { version = '1.0.0' } = {}) {
  const coll = collection || {};
  const paths = {};
  const tags = new Set();
  let operationIndex = 0;

  walk(coll.items, null, (request, tag, ancestors) => {
    const effective = resolveRequestValidations(request, [coll, ...ancestors]);
    const method = String(request.method || 'GET').toLowerCase();
    const path = requestPath(request.url);
    const operation = {
      operationId: `${method}_${slug(request.name) || 'request'}_${operationIndex += 1}`,
      summary: request.name || `${method.toUpperCase()} ${path}`,
      responses: responsesFor(request, effective.responseValidations),
    };
    if (request.description) operation.description = String(request.description);
    if (tag) {
      tags.add(tag);
      operation.tags = [tag];
    }

    const parameters = requestParameters(request, path, effective.fieldValidations);
    if (parameters.length > 0) operation.parameters = parameters;

    if (BODY_METHODS.has(method)) {
      const validations = effective.fieldValidations;
      const body = bodyContent(request.body, validations.body);
      if (body) {
        operation.requestBody = {
          required: true,
          content: {
            [body.mediaType]: {
              schema: body.schema || { type: typeOf(body.example), example: body.example },
            },
          },
        };
      }
    }

    paths[path] = paths[path] || {};
    paths[path][method] = operation;
  });

  const spec = {
    openapi: '3.0.3',
    info: {
      title: coll.name || 'Collection',
      version,
    },
    paths,
  };
  if (coll.description) spec.info.description = String(coll.description);
  if (tags.size > 0) spec.tags = [...tags].map((name) => ({ name }));
  return spec;
}
