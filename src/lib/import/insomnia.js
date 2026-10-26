// Insomnia v4 export -> internal collection + environments.
//
// Export shape: `{ resources: [{ _id, _type, parentId, ... }] }` where `_type`
// is one of workspace | environment | request | request_group | api_spec.
// Groups nest through parentId; anything whose parent is unknown (including
// the workspace itself) stays at the collection root. `api_spec` resources are
// ignored. Malformed resources are skipped instead of aborting the import.
import {
  newCollection,
  newRequest,
  newBody,
  newAuth,
  newEnvironment,
  newKeyValue,
} from '../factory.js';
import { newFolder } from '../collectionTree.js';

function resourceType(resource) {
  return typeof resource?._type === 'string' ? resource._type : '';
}

function buildUrl(resource) {
  let url = typeof resource.url === 'string' ? resource.url : '';
  const parameters = Array.isArray(resource.parameters)
    ? resource.parameters.filter((param) => param && param.name && !param.disabled)
    : [];
  if (parameters.length > 0) {
    const query = parameters
      .map((param) => {
        const value = param.value === undefined || param.value === null ? '' : String(param.value);
        return `${encodeURIComponent(String(param.name))}=${encodeURIComponent(value)}`;
      })
      .join('&');
    url += url.includes('?') ? `&${query}` : `?${query}`;
  }
  return url;
}

function buildHeaders(resource) {
  const headers = Array.isArray(resource.headers) ? resource.headers : [];
  return headers
    .filter((header) => header && header.name)
    .map((header) => ({
      ...newKeyValue(),
      key: String(header.name),
      value: header.value === undefined || header.value === null ? '' : String(header.value),
      enabled: header.disabled !== true,
    }));
}

function buildAuth(authentication) {
  if (!authentication || typeof authentication !== 'object') return null;
  const type = String(authentication.type || '').toLowerCase();
  const text = (value) => (typeof value === 'string' ? value : '');
  if (type === 'basic') {
    return {
      type: 'basic',
      basic: { username: text(authentication.username), password: text(authentication.password) },
    };
  }
  if (type === 'bearer') {
    return { type: 'bearer', bearer: { token: text(authentication.token) } };
  }
  if (type === 'none') {
    return { ...newAuth(), type: 'none' };
  }
  return null;
}

function formRows(params) {
  return (Array.isArray(params) ? params : [])
    .filter((param) => param && param.name)
    .map((param) => ({
      key: String(param.name),
      value: param.value === undefined || param.value === null ? '' : String(param.value),
      enabled: param.disabled !== true,
    }));
}

function buildBody(body) {
  if (!body || typeof body !== 'object') return null;
  const mimeType = String(body.mimeType || '').toLowerCase();
  const text = typeof body.text === 'string' ? body.text : '';
  if (mimeType === 'application/json') {
    return { ...newBody(), mode: 'json', raw: text };
  }
  if (mimeType === 'application/x-www-form-urlencoded') {
    return { ...newBody(), mode: 'form-urlencoded', form: formRows(body.params) };
  }
  if (mimeType === 'multipart/form-data') {
    return { ...newBody(), mode: 'form-data', form: formRows(body.params) };
  }
  if (mimeType.startsWith('text/')) {
    return { ...newBody(), mode: 'raw', raw: text };
  }
  return null;
}

function buildRequest(resource) {
  const request = newRequest();
  request.type = 'request';
  request.name = typeof resource.name === 'string' && resource.name.trim()
    ? resource.name.trim()
    : 'Untitled Request';
  request.method = typeof resource.method === 'string' && resource.method.trim()
    ? resource.method.trim().toUpperCase()
    : 'GET';
  request.url = buildUrl(resource);
  request.headers = buildHeaders(resource);

  const auth = buildAuth(resource.authentication);
  if (auth) request.auth = { ...newAuth(), ...auth };

  const body = buildBody(resource.body);
  if (body) request.body = body;

  return request;
}

function buildEnvironment(resource) {
  const environment = newEnvironment(
    typeof resource.name === 'string' && resource.name.trim()
      ? resource.name.trim()
      : 'Imported Environment'
  );
  const data = resource.data && typeof resource.data === 'object' ? resource.data : {};
  environment.variables = Object.entries(data)
    .filter(([key]) => !key.startsWith('__'))
    .map(([key, value]) => ({
      key,
      value: value === undefined || value === null ? '' : String(value),
      enabled: true,
    }));
  return environment;
}

/**
 * Convert an Insomnia v4 export into `{ collection, environments }`.
 * Unknown parents fall back to the collection root; never throws.
 */
export function fromInsomnia(json) {
  const doc = json && typeof json === 'object' ? json : {};
  const resources = (Array.isArray(doc.resources) ? doc.resources : [])
    .filter((resource) => resource && typeof resource === 'object');

  const workspace = resources.find((resource) => resourceType(resource) === 'workspace');
  const collection = newCollection(
    typeof workspace?.name === 'string' && workspace.name.trim()
      ? workspace.name.trim()
      : 'Insomnia Import'
  );

  // Pass 1: create every folder so children can attach regardless of order.
  const folders = new Map();
  for (const resource of resources) {
    if (resourceType(resource) !== 'request_group') continue;
    const folder = newFolder(
      typeof resource.name === 'string' && resource.name.trim() ? resource.name.trim() : 'Folder'
    );
    folders.set(resource._id, folder);
  }

  const environments = resources
    .filter((resource) => resourceType(resource) === 'environment')
    .map(buildEnvironment);

  // Pass 2: attach folders and requests to their parent folder, else root.
  for (const resource of resources) {
    const type = resourceType(resource);
    let node = null;
    if (type === 'request_group') node = folders.get(resource._id);
    else if (type === 'request') node = buildRequest(resource);
    else continue; // workspace, environment, api_spec, unknown

    if (!node) continue;
    const parent = resource.parentId ? folders.get(resource.parentId) : null;
    if (parent) parent.items.push(node);
    else collection.items.push(node);
  }

  return { collection, environments };
}
