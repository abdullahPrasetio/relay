// Format detection + one-shot import used by the Import button.
//
// Every converter returns plain internal shapes (newCollection/newRequest), so
// the result is passed through normalizeCollection to guarantee the tree shape
// regardless of the source format.

import { newCollection } from '../factory.js';
import { normalizeCollection } from '../collectionTree.js';
import { fromPostmanCollection } from '../postmanFormat.js';
import { fromCurl } from './curl.js';
import { fromHar } from './har.js';
import { fromOpenApi } from './openapi.js';
import { fromInsomnia } from './insomnia.js';

const POSTMAN_SCHEMA = /getpostman\.com\/json\/collection/i;

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Identify the import format of a file's text, or null when unrecognized. */
export function detectFormat(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const json = parseJson(raw);
  if (json) {
    if (json.info && (POSTMAN_SCHEMA.test(String(json.info.schema || '')) || Array.isArray(json.item))) {
      return 'postman';
    }
    if (json.openapi && String(json.openapi).startsWith('3')) return 'openapi';
    if (json.swagger) return 'swagger2';
    if (json.log && Array.isArray(json.log.entries)) return 'har';
    if (Array.isArray(json.resources) && json.resources.some((r) => r && r._type)) {
      return 'insomnia';
    }
    return null;
  }

  // Plain text: only cURL is supported, and the first token must be the verb so
  // arbitrary text containing the word "curl" does not register.
  if (/^(?:\$\s*)?curl\s/i.test(raw)) return 'curl';
  return null;
}

function wrapRequest(request, name) {
  const collection = newCollection(name);
  collection.items = [{ ...request, id: request.id, name: request.name || name, type: 'request' }];
  return collection;
}

/**
 * Convert text in a known format.
 * Returns `{ collections, environments }`; throws when the format is unknown
 * or the converter rejects the input.
 */
export function importAs(format, text) {
  const raw = String(text || '');
  switch (format) {
    case 'postman':
      return { collections: [fromPostmanCollection(parseJson(raw))], environments: [] };
    case 'openapi':
    case 'swagger2':
      return { collections: [fromOpenApi(parseJson(raw)).collection], environments: [] };
    case 'har':
      return { collections: [fromHar(parseJson(raw)).collection], environments: [] };
    case 'curl':
      return { collections: [wrapRequest(fromCurl(raw), 'cURL Import')], environments: [] };
    case 'insomnia': {
      const out = fromInsomnia(parseJson(raw));
      return { collections: [out.collection], environments: out.environments || [] };
    }
    default:
      throw new Error(`Unsupported import format: ${format}`);
  }
}

/** Detect the format, then import. One call site for the Import button. */
export function importAny(text) {
  const format = detectFormat(text);
  if (!format) {
    throw new Error('Unrecognized format. Supported: Postman, OpenAPI, Swagger 2, HAR, cURL, Insomnia.');
  }
  const result = importAs(format, text);
  return {
    format,
    collections: result.collections.filter(Boolean).map(normalizeCollection),
    environments: result.environments || [],
  };
}
