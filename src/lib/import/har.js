// HAR (HTTP Archive) -> internal collection converter.
//
// Pure ESM. Only `log.entries[].request` is used; responses, timings and
// cookies from the archive are ignored on purpose (Relay stores requests, not
// recordings).

import { newCollection, newRequest } from '../factory.js';
import { newFolder } from '../collectionTree.js';

const SKIPPED_HEADERS = new Set(['content-length', 'host']);

function parseHost(url) {
  try {
    return new URL(url).host || '';
  } catch {
    return '';
  }
}

function parsePathname(url) {
  try {
    return new URL(url).pathname || '/';
  } catch {
    return url;
  }
}

function convertHeaders(rawHeaders, mimeType) {
  const headers = [];
  const seen = new Set();
  for (const header of Array.isArray(rawHeaders) ? rawHeaders : []) {
    const name = String(header?.name ?? '').trim();
    if (!name) continue;
    const lower = name.toLowerCase();
    if (lower.startsWith(':') || SKIPPED_HEADERS.has(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    headers.push({ key: name, value: String(header.value ?? ''), enabled: true });
  }
  // The archive's Content-Type may live only in `postData.mimeType`.
  if (mimeType && !seen.has('content-type')) {
    headers.push({ key: 'Content-Type', value: mimeType, enabled: true });
  }
  return headers;
}

function convertBody(postData) {
  if (!postData || typeof postData !== 'object') return null;
  const mimeType = String(postData.mimeType || '').toLowerCase();
  const text = postData.text ?? '';
  const params = Array.isArray(postData.params) ? postData.params : [];

  if (mimeType.includes('json')) {
    return { mode: 'json', raw: text, form: [], graphql: { query: '', variables: '' } };
  }
  if (mimeType.includes('x-www-form-urlencoded')) {
    return {
      mode: 'form-urlencoded',
      raw: text,
      form: params.map((param) => ({
        key: String(param.name ?? ''),
        value: String(param.value ?? ''),
        enabled: true,
      })),
      graphql: { query: '', variables: '' },
    };
  }
  if (mimeType.includes('multipart/form-data')) {
    return {
      mode: 'form-data',
      raw: text,
      form: params.map((param) => {
        const key = String(param.name ?? '');
        if (param.fileName) {
          const filePath = String(param.value || param.fileName || '');
          return {
            key,
            type: 'file',
            filePath,
            fileName: String(param.fileName),
            contentType: String(param.contentType || ''),
            enabled: true,
          };
        }
        return { key, value: String(param.value ?? ''), enabled: true };
      }),
      graphql: { query: '', variables: '' },
    };
  }
  if (text) {
    return { mode: 'raw', raw: text, form: [], graphql: { query: '', variables: '' } };
  }
  return null;
}

function convertEntry(entry) {
  const source = entry?.request;
  const url = typeof source?.url === 'string' ? source.url : '';
  if (!/^https?:\/\//i.test(url)) return null;

  const host = parseHost(url);
  if (!host) return null;

  const method = String(source.method || 'GET').toUpperCase();
  const mimeType = source.postData?.mimeType || '';
  const body = convertBody(source.postData);

  const request = newRequest({
    name: `${method} ${parsePathname(url)}`,
    method,
    url,
    params: [],
    headers: convertHeaders(source.headers, mimeType),
    ...(body ? { body } : {}),
  });

  return { host, request };
}

/**
 * Convert a parsed HAR document into `{ collection }`.
 *
 * Collection name rule (deterministic): `Imported HAR (<first host>)` when the
 * HAR declares a creator (`info.creator`, or `log.creator` as used by HAR 1.2
 * exporters), otherwise `Imported HAR`. Entries are grouped into one folder per
 * host; with a single host and a single entry the request sits at the
 * collection root instead.
 */
export function fromHar(json) {
  const entries = Array.isArray(json?.log?.entries) ? json.log.entries : [];
  const converted = [];
  for (const entry of entries) {
    const item = convertEntry(entry);
    if (item) converted.push(item);
  }

  const creator = json?.info?.creator?.name || json?.log?.creator?.name;
  const firstHost = converted[0]?.host || '';
  const collection = newCollection(
    creator ? `Imported HAR${firstHost ? ` (${firstHost})` : ''}` : 'Imported HAR'
  );

  if (!converted.length) {
    collection.items = [];
  } else if (converted.length === 1) {
    collection.items = [{ ...converted[0].request, type: 'request' }];
  } else {
    const byHost = new Map();
    for (const { host, request } of converted) {
      if (!byHost.has(host)) byHost.set(host, []);
      byHost.get(host).push({ ...request, type: 'request' });
    }
    collection.items = [...byHost.entries()].map(([host, requests]) => {
      const folder = newFolder(host);
      folder.items = requests;
      return folder;
    });
  }

  return { collection };
}
