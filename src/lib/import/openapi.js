// OpenAPI 3.x / Swagger 2.0 -> internal collection tree.
//
// Whole-path importer: every allowed operation becomes one request grouped into
// a folder named after its first tag (or `default`). Paths keep `:param`
// placeholders so the URL bar and pathVars agree.
//
// Description decision: internal requests have no `description` field, so an
// operation's summary/description is never stored on the request. A request is
// named `operationId || summary || "METHOD /path"` instead, the document's
// `info.description` becomes the collection description, and tag descriptions
// become folder descriptions. This keeps notes discoverable without inventing
// request fields that the rest of the app does not render.
import {
  newCollection,
  newRequest,
  newBody,
  newAuth,
  newKeyValue,
} from '../factory.js';
import { newFolder } from '../collectionTree.js';
import {
  hasValidation,
  normalizeFieldValidations,
  normalizeResponseValidations,
} from '../fieldValidations.js';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isJsonMedia(media) {
  const value = String(media || '').toLowerCase().split(';')[0].trim();
  if (!value) return false;
  return value === 'application/json' || /\+json$/.test(value);
}

// Prefer an explicit example/default, in that order, then fall back to ''.
function pickValue(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string') return candidate;
    if (typeof candidate === 'number' || typeof candidate === 'boolean') return String(candidate);
  }
  return '';
}

function mergeAuth(base, partial) {
  if (!partial) return base;
  return {
    ...base,
    ...partial,
    bearer: { ...base.bearer, ...(partial.bearer || {}) },
    basic: { ...base.basic, ...(partial.basic || {}) },
    apikey: { ...base.apikey, ...(partial.apikey || {}) },
    oauth2: { ...base.oauth2, ...(partial.oauth2 || {}) },
  };
}

function authFromScheme(scheme) {
  if (!scheme || typeof scheme !== 'object') return null;
  const type = String(scheme.type || '').toLowerCase();
  const httpScheme = String(scheme.scheme || '').toLowerCase();

  if (type === 'http' && httpScheme === 'bearer') {
    return { type: 'bearer', bearer: { token: '{{token}}' } };
  }
  if (type === 'http' && httpScheme === 'basic') {
    return { type: 'basic', basic: { username: '{{username}}', password: '{{password}}' } };
  }
  if (type === 'basic') {
    return { type: 'basic', basic: { username: '{{username}}', password: '{{password}}' } };
  }
  if (type === 'apikey') {
    return {
      type: 'apikey',
      apikey: {
        key: String(scheme.name || 'X-API-Key'),
        value: '{{apiKey}}',
        addTo: String(scheme.in || '').toLowerCase() === 'query' ? 'query' : 'header',
      },
    };
  }
  return null;
}

// First requirement of the first security entry, resolved against the scheme
// map. Empty requirement lists mean "no auth".
function authFromSecurity(security, schemes) {
  if (!Array.isArray(security)) return null;
  if (security.length === 0) return { ...newAuth(), type: 'none' };
  for (const requirement of security) {
    if (!requirement || typeof requirement !== 'object') continue;
    const name = Object.keys(requirement)[0];
    if (!name) continue;
    const auth = authFromScheme(schemes?.[name]);
    if (auth) return auth;
  }
  return null;
}

// Resolve a local JSON pointer such as `#/components/schemas/Pet`. One hop is
// enough for import; nested values are resolved lazily by schemaExample.
function makeRefResolver(doc) {
  return (ref) => {
    if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
    const parts = ref.slice(2).split('/');
    let node = doc;
    for (const rawPart of parts) {
      const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~');
      if (node == null || typeof node !== 'object') return null;
      node = node[part];
    }
    return node && typeof node === 'object' ? node : null;
  };
}

// Build a JSON-ish example from a schema: `example` > `examples` > `default`,
// else a type placeholder. $refs are resolved (with a depth guard) so nested
// object schemas remain importable.
function schemaExample(schema, resolveRef, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 8) return '';
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.default !== undefined) return schema.default;

  let node = schema;
  if (typeof node.$ref === 'string') {
    node = resolveRef(node.$ref);
    if (!node) return {};
    return schemaExample(node, resolveRef, depth + 1);
  }

  const type = String(
    node.type || (node.properties ? 'object' : node.items ? 'array' : '')
  ).toLowerCase();

  if (type === 'object' || node.properties) {
    const out = {};
    for (const [key, prop] of Object.entries(node.properties || {})) {
      out[key] = schemaExample(prop, resolveRef, depth + 1);
    }
    return out;
  }
  if (type === 'array') return [];
  if (type === 'integer' || type === 'number') return 0;
  if (type === 'boolean') return false;
  return '';
}

function mediaExample(mediaObj, resolveRef) {
  if (mediaObj && mediaObj.example !== undefined) return mediaObj.example;
  const examples = mediaObj?.examples;
  if (examples && typeof examples === 'object') {
    for (const entry of Object.values(examples)) {
      if (entry && entry.value !== undefined) return entry.value;
    }
  }
  return schemaExample(mediaObj?.schema, resolveRef);
}

function ensureHeader(headers, key, value) {
  const lowered = key.toLowerCase();
  if (headers.some((h) => String(h.key || '').toLowerCase() === lowered)) return;
  headers.push({ ...newKeyValue(), key, value });
}

function applyJsonBody(request, value) {
  const example = value === undefined || value === null ? {} : value;
  request.body = {
    ...newBody(),
    mode: 'json',
    raw: JSON.stringify(example, null, 2),
  };
  ensureHeader(request.headers, 'Content-Type', 'application/json');
}

function applyRawBody(request, value, mediaType) {
  let raw = '';
  if (typeof value === 'string') raw = value;
  else if (value !== undefined && value !== null) raw = JSON.stringify(value, null, 2);
  request.body = { ...newBody(), mode: 'raw', raw };
  if (mediaType) ensureHeader(request.headers, 'Content-Type', mediaType);
}

function mergedParameters(pathItem, operation) {
  const map = new Map();
  for (const param of [...(pathItem?.parameters || []), ...(operation?.parameters || [])]) {
    if (!param || typeof param !== 'object' || !param.name) continue;
    map.set(`${param.in || ''}:${param.name}`, param);
  }
  return [...map.values()];
}

function paramValue(param) {
  const schema = param.schema && typeof param.schema === 'object' ? param.schema : {};
  return pickValue(
    param.example,
    schema.example,
    param.default,
    schema.default,
    Array.isArray(schema.enum) ? schema.enum[0] : undefined
  );
}

function baseUrlFor(doc, isSwagger) {
  if (isSwagger) {
    const scheme = Array.isArray(doc.schemes) && str(doc.schemes[0]) ? str(doc.schemes[0]) : 'https';
    const host = str(doc.host);
    const basePath = str(doc.basePath).replace(/\/+$/, '');
    if (host) return `${scheme}://${host}${basePath}`;
    return basePath;
  }

  const server = Array.isArray(doc.servers) && doc.servers.length > 0 ? doc.servers[0] : null;
  let url = str(server?.url);
  if (!url) return '';
  const variables = server.variables && typeof server.variables === 'object' ? server.variables : {};
  url = url.replace(/\{([^}]+)\}/g, (_match, name) => {
    const variable = variables[name];
    const fallback = variable && variable.default !== undefined && variable.default !== ''
      ? String(variable.default)
      : '';
    return fallback || `{{${name}}}`;
  });
  return url.replace(/\/+$/, '');
}

function requestName(operation, method, path) {
  return (
    str(operation?.operationId) ||
    str(operation?.summary) ||
    `${method.toUpperCase()} ${path}`
  );
}

function pathToUrl(path) {
  return String(path || '').replace(/\{([^}/]+)\}/g, ':$1');
}

function schemaRule(schema, required, resolveRef) {
  if (!schema || typeof schema !== 'object') return null;
  const node = typeof schema.$ref === 'string' ? resolveRef(schema.$ref) : schema;
  if (!node || typeof node !== 'object') return null;
  const types = Array.isArray(node.type) ? node.type : [node.type];
  const type = String(types.find((entry) => entry && entry !== 'null') || '').toLowerCase();
  const rules = [];
  if (required) rules.push('required');
  if (node.nullable === true || types.includes('null')) rules.push('nullable');
  if (type === 'integer') rules.push('integer');
  else if (type === 'number') rules.push('numeric');
  else if (type === 'boolean') rules.push('boolean');
  else if (type === 'array') rules.push('array');
  else if (type === 'object') rules.push('object');
  else if (type === 'string') rules.push('string');
  if (node.uniqueItems === true) rules.push('unique');
  const format = str(node.format).toLowerCase();
  if (format === 'email') rules.push('email');
  else if (format === 'uri' || format === 'url') rules.push('url');

  const rule = {
    rules,
    minLength: Number.isFinite(Number(node.minLength)) ? Number(node.minLength) : null,
    maxLength: Number.isFinite(Number(node.maxLength)) ? Number(node.maxLength) : null,
    minimum: Number.isFinite(Number(node.minimum)) ? Number(node.minimum) : null,
    maximum: Number.isFinite(Number(node.maximum)) ? Number(node.maximum) : null,
    minItems: Number.isFinite(Number(node.minItems)) ? Number(node.minItems) : null,
    maxItems: Number.isFinite(Number(node.maxItems)) ? Number(node.maxItems) : null,
    pattern: str(node.pattern),
    format: format && format !== 'email' && format !== 'uri' && format !== 'url' ? format : '',
    enum: Array.isArray(node.enum) ? node.enum.map((value) => String(value)) : [],
    example: node.example !== undefined ? String(node.example) : '',
    default: node.default !== undefined ? String(node.default) : '',
    description: str(node.description),
  };
  return hasValidation(rule) ? rule : null;
}

function collectSchemaValidations(schema, resolveRef, prefix = '', out = {}) {
  if (!schema || typeof schema !== 'object') return out;
  const node = typeof schema.$ref === 'string' ? resolveRef(schema.$ref) : schema;
  if (!node || typeof node !== 'object') return out;
  const properties = node.properties && typeof node.properties === 'object' ? node.properties : null;
  if (!properties) return out;
  const required = new Set(Array.isArray(node.required) ? node.required : []);
  for (const [key, child] of Object.entries(properties)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const childNode = child && typeof child === 'object' && typeof child.$ref === 'string'
      ? resolveRef(child.$ref)
      : child;
    const isArray =
      childNode &&
      typeof childNode === 'object' &&
      (String(childNode.type || '').toLowerCase() === 'array' || childNode.items);
    const rulePath = isArray ? `${path}[]` : path;
    const rule = schemaRule(child, required.has(key), resolveRef);
    if (rule) out[rulePath] = rule;
    if (childNode && typeof childNode === 'object' && childNode.properties) {
      collectSchemaValidations(childNode, resolveRef, rulePath, out);
    }
    if (childNode && typeof childNode === 'object' && childNode.items) {
      collectSchemaValidations(childNode.items, resolveRef, rulePath, out);
    }
  }
  return out;
}

function parameterSchema(param) {
  if (param?.schema && typeof param.schema === 'object') return param.schema;
  return param && typeof param === 'object' ? param : null;
}

function addParameterValidation(validations, section, param, resolveRef) {
  const name = String(param?.name || '');
  if (!name) return;
  const schema = parameterSchema(param);
  const rule = schemaRule(schema, param?.required === true, resolveRef);
  if (rule) validations[section][name] = rule;
}

function buildOpenApiBody(operation, resolveRef) {
  const rawBody = operation?.requestBody;
  if (!rawBody || typeof rawBody !== 'object') return null;
  const bodyObj = typeof rawBody.$ref === 'string' ? resolveRef(rawBody.$ref) : rawBody;
  const content = bodyObj?.content && typeof bodyObj.content === 'object' ? bodyObj.content : null;
  if (!content) return null;
  const entries = Object.entries(content).filter(([, media]) => media && typeof media === 'object');
  if (entries.length === 0) return null;

  const jsonEntry = entries.find(([mediaType]) => isJsonMedia(mediaType));
  const [mediaType, mediaObj] = jsonEntry || entries[0];
  if (jsonEntry) {
    return {
      kind: 'json',
      value: mediaExample(mediaObj, resolveRef),
      schema: mediaObj?.schema,
    };
  }
  return {
    kind: 'raw',
    value: mediaExample(mediaObj, resolveRef),
    mediaType,
    schema: mediaObj?.schema,
  };
}

function buildSwaggerBody(operation, parameters, resolveRef, consumes) {
  const bodyParam = parameters.find((p) => String(p.in || '').toLowerCase() === 'body');
  if (!bodyParam) return null;
  const schema = bodyParam.schema && typeof bodyParam.schema === 'object' ? bodyParam.schema : bodyParam;
  const mediaTypes = Array.isArray(consumes) && consumes.length > 0
    ? consumes.filter((m) => typeof m === 'string')
    : [];
  const mediaType = mediaTypes.find((m) => isJsonMedia(m)) || mediaTypes[0] || 'application/json';
  const value = schemaExample(schema, resolveRef);
  if (isJsonMedia(mediaType)) return { kind: 'json', value, schema };
  return { kind: 'raw', value, mediaType, schema };
}

function buildRequest({ doc, path, pathItem, method, operation, isSwagger, resolveRef }) {
  const name = requestName(operation, method, path);
  const parameters = mergedParameters(pathItem, operation);

  const request = newRequest({
    name,
    method: method.toUpperCase(),
    url: '',
  });
  request.type = 'request';

  const base = baseUrlFor(doc, isSwagger);
  request.url = `${base}${pathToUrl(path)}`;

  request.pathVars = parameters
    .filter((p) => String(p.in || '').toLowerCase() === 'path')
    .map((p) => ({ key: String(p.name), value: paramValue(p) }));

  request.params = parameters
    .filter((p) => String(p.in || '').toLowerCase() === 'query')
    .map((p) => ({ ...newKeyValue(), key: String(p.name), value: paramValue(p), enabled: true }));

  const body = isSwagger
    ? buildSwaggerBody(operation, parameters, resolveRef, doc.consumes)
    : buildOpenApiBody(operation, resolveRef);
  if (body?.kind === 'json') applyJsonBody(request, body.value);
  else if (body?.kind === 'raw') applyRawBody(request, body.value, body.mediaType);

  const schemes = isSwagger
    ? (doc.securityDefinitions && typeof doc.securityDefinitions === 'object' ? doc.securityDefinitions : {})
    : (doc.components?.securitySchemes && typeof doc.components.securitySchemes === 'object'
      ? doc.components.securitySchemes
      : {});
  if (Array.isArray(operation.security)) {
    const override = authFromSecurity(operation.security, schemes);
    if (override) request.auth = mergeAuth(newAuth(), override);
  }

  const validations = { path: {}, params: {}, headers: {}, body: {} };
  for (const param of parameters) {
    const where = String(param.in || '').toLowerCase();
    if (where === 'path') addParameterValidation(validations, 'path', param, resolveRef);
    else if (where === 'query') addParameterValidation(validations, 'params', param, resolveRef);
    else if (where === 'header') addParameterValidation(validations, 'headers', param, resolveRef);
  }
  if (body?.schema) {
    collectSchemaValidations(body.schema, resolveRef, '', validations.body);
  }
  request.fieldValidations = normalizeFieldValidations(validations);

  const responseValidations = { body: {}, headers: {} };
  const responseEntries = Object.entries(
    operation.responses && typeof operation.responses === 'object' ? operation.responses : {}
  );
  const success = responseEntries.find(([status]) => /^2\d\d$/.test(String(status))) || responseEntries[0];
  if (success) {
    const response = typeof success[1]?.$ref === 'string'
      ? resolveRef(success[1].$ref)
      : success[1];
    if (response && typeof response === 'object') {
      const content = response.content && typeof response.content === 'object' ? response.content : null;
      const media = content
        ? Object.entries(content).find(([type]) => isJsonMedia(type))?.[1] || Object.values(content)[0]
        : null;
      const schema = media?.schema || response.schema;
      if (schema) collectSchemaValidations(schema, resolveRef, '', responseValidations.body);
      for (const [name, header] of Object.entries(response.headers || {})) {
        const headerNode = typeof header?.$ref === 'string' ? resolveRef(header.$ref) : header;
        const rule = schemaRule(headerNode?.schema || headerNode, false, resolveRef);
        if (rule) responseValidations.headers[name] = rule;
      }
    }
  }
  request.responseValidations = normalizeResponseValidations(responseValidations);

  return request;
}

/**
 * Convert an OpenAPI 3.x or Swagger 2.0 document into `{ collection }`.
 * Never throws on a single malformed operation: it is skipped.
 */
export function fromOpenApi(json) {
  const doc = json && typeof json === 'object' ? json : {};
  const isSwagger = !doc.openapi && Boolean(doc.swagger);
  const info = doc.info && typeof doc.info === 'object' ? doc.info : {};
  const collection = newCollection(str(info.title) || 'OpenAPI Import');
  collection.description = typeof info.description === 'string' ? info.description : '';

  const resolveRef = makeRefResolver(doc);
  const schemes = isSwagger
    ? (doc.securityDefinitions && typeof doc.securityDefinitions === 'object' ? doc.securityDefinitions : {})
    : (doc.components?.securitySchemes && typeof doc.components.securitySchemes === 'object'
      ? doc.components.securitySchemes
      : {});
  const collectionAuth = authFromSecurity(doc.security, schemes);
  if (collectionAuth) collection.auth = mergeAuth(newAuth(), collectionAuth);

  const tagDescriptions = new Map();
  for (const tag of Array.isArray(doc.tags) ? doc.tags : []) {
    if (tag && typeof tag.name === 'string' && typeof tag.description === 'string') {
      tagDescriptions.set(tag.name, tag.description);
    }
  }

  const folders = new Map();
  const folderFor = (name) => {
    if (!folders.has(name)) {
      const folder = newFolder(name);
      folder.description = tagDescriptions.get(name) || '';
      folders.set(name, folder);
      collection.items.push(folder);
    }
    return folders.get(name);
  };

  const paths = doc.paths && typeof doc.paths === 'object' ? doc.paths : {};
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation || typeof operation !== 'object') continue;
      try {
        const request = buildRequest({
          doc,
          path,
          pathItem,
          method,
          operation,
          isSwagger,
          resolveRef,
        });
        const tag = Array.isArray(operation.tags) && str(operation.tags[0])
          ? str(operation.tags[0])
          : 'default';
        folderFor(tag).items.push(request);
      } catch {
        // Skip a single malformed operation; keep importing the rest.
      }
    }
  }

  return { collection };
}
