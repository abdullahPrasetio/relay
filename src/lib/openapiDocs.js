// OpenAPI 3.0 generation for a Relay collection.
//
// Pure module: no DOM, Electron or network. The Confluence sync renders this
// spec as raw JSON or embeds it in the Swagger UI macro. Only enabled fields
// are emitted; credentials (Authorization/Cookie headers) are never included.

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

function bodyContent(body) {
  if (!body || body.mode === 'none') return null;
  if (body.mode === 'json' || body.mode === 'raw') {
    const raw = String(body.raw || '');
    if (!raw.trim()) return null;
    const parsed = parseJson(raw);
    const value = parsed === undefined ? raw : parsed;
    return {
      mediaType: parsed === undefined ? 'text/plain' : 'application/json',
      example: value,
    };
  }
  if (body.mode === 'form-urlencoded' || body.mode === 'form-data') {
    const example = {};
    for (const row of rows(body.form)) {
      if (row.key) example[row.key] = row.value ?? '';
    }
    if (Object.keys(example).length === 0) return null;
    return {
      mediaType:
        body.mode === 'form-data' ? 'multipart/form-data' : 'application/x-www-form-urlencoded',
      example,
    };
  }
  if (body.mode === 'graphql') {
    const query = String(body.graphql?.query || '').trim();
    if (!query) return null;
    const variables = parseJson(body.graphql?.variables);
    return {
      mediaType: 'application/json',
      example: variables === undefined ? { query } : { query, variables },
    };
  }
  return null;
}

function requestParameters(request, path) {
  const params = [];
  const pathVars = new Map(
    rows(request.pathVars)
      .filter((row) => row.key)
      .map((row) => [row.key, row.value ?? ''])
  );
  for (const match of String(path).matchAll(/\{([^}]+)\}/g)) {
    const name = match[1];
    const parameter = {
      name,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    };
    if (pathVars.has(name)) parameter.example = pathVars.get(name);
    params.push(parameter);
  }

  for (const row of rows(request.params)) {
    if (!row.key) continue;
    params.push({
      name: row.key,
      in: 'query',
      required: false,
      schema: { type: 'string' },
      ...(row.value !== undefined ? { example: row.value } : {}),
    });
  }

  for (const row of rows(request.headers)) {
    const name = String(row.key || '').trim();
    if (!name || SECRET_HEADERS.has(name.toLowerCase())) continue;
    params.push({
      name,
      in: 'header',
      required: false,
      schema: { type: 'string' },
      ...(row.value !== undefined ? { example: row.value } : {}),
    });
  }

  return params;
}

function exampleResponse(example, index) {
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
        schema: { type: isJson && parsed !== undefined ? typeOf(parsed) : 'string' },
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
    headers[row.key] = {
      schema: { type: 'string' },
      ...(row.value !== undefined ? { example: row.value } : {}),
    };
  }
  if (Object.keys(headers).length > 0) result.headers = headers;
  return { statusKey, result };
}

function responsesFor(request) {
  const examples = Array.isArray(request.examples) ? request.examples.filter(Boolean) : [];
  if (examples.length === 0) {
    return { 200: { description: 'Success' } };
  }
  const responses = {};
  examples.forEach((example, index) => {
    const { statusKey, result } = exampleResponse(example, index);
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

function walk(items, tag, visit) {
  for (const node of Array.isArray(items) ? items : []) {
    if (!node) continue;
    if (node.type === 'folder') {
      walk(node.items, node.name || tag, visit);
      continue;
    }
    visit(node, tag);
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

  walk(coll.items, null, (request, tag) => {
    const method = String(request.method || 'GET').toLowerCase();
    const path = requestPath(request.url);
    const operation = {
      operationId: `${method}_${slug(request.name) || 'request'}_${operationIndex += 1}`,
      summary: request.name || `${method.toUpperCase()} ${path}`,
      responses: responsesFor(request),
    };
    if (request.description) operation.description = String(request.description);
    if (tag) {
      tags.add(tag);
      operation.tags = [tag];
    }

    const parameters = requestParameters(request, path);
    if (parameters.length > 0) operation.parameters = parameters;

    if (BODY_METHODS.has(method)) {
      const body = bodyContent(request.body);
      if (body) {
        operation.requestBody = {
          required: true,
          content: {
            [body.mediaType]: {
              schema: { type: typeOf(body.example), example: body.example },
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
