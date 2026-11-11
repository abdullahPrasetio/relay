// Confluence storage-format XHTML for a collection.
//
// Pure module: no DOM, no Electron, no network. The caller (renderer) builds
// the document and the main process publishes it. Everything interpolated is
// escaped for XML; code payloads use CDATA with the `]]>` sequence split so a
// value can never break out of the macro. Secrets are never emitted.
import {
  bodyValidationFields,
  normalizeFieldValidations,
  pathValidationFields,
  validationTokens,
} from './fieldValidations.js';
import { collectionToOpenApi } from './openapiDocs.js';

export const CONFLUENCE_CONTENT_MODES = Object.freeze([
  'documentation',
  'openapi',
  'swagger',
  'both',
]);
export const CONFLUENCE_CONTENT_ORDERS = Object.freeze(['doc_first', 'openapi_first']);

export function normalizeConfluenceContentMode(value) {
  return CONFLUENCE_CONTENT_MODES.includes(value) ? value : 'documentation';
}

export function normalizeConfluenceContentOrder(value) {
  return CONFLUENCE_CONTENT_ORDERS.includes(value) ? value : 'doc_first';
}

// XML 1.0 forbids most C0 controls; strip them before escaping.
// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

/** Escape text/attribute content for XML (storage format is XHTML-like). */
export function escapeXml(value) {
  return String(value ?? '')
    .replace(INVALID_XML_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Wrap text in CDATA, splitting any `]]>` so the section stays valid. */
export function cdata(value) {
  return `<![CDATA[${String(value ?? '').replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

function methodColor(method) {
  const colors = {
    GET: '#2f7d32',
    POST: '#a35c00',
    PUT: '#1f5fbf',
    PATCH: '#7c3aed',
    DELETE: '#b3261e',
    HEAD: '#4b5563',
    OPTIONS: '#4b5563',
  };
  return colors[String(method || 'GET').toUpperCase()] || '#6b7280';
}

function codeMacro(text, language, { title = '' } = {}) {
  const lang = language ? `<ac:parameter ac:name="language">${escapeXml(language)}</ac:parameter>` : '';
  const name = title ? `<ac:parameter ac:name="title">${escapeXml(title)}</ac:parameter>` : '';
  return `<ac:structured-macro ac:name="code">${lang}${name}<ac:plain-text-body>${cdata(text)}</ac:plain-text-body></ac:structured-macro>`;
}

function table(headers, rows, { enabled = false } = {}) {
  const head = headers.map((h) => `<th>${escapeXml(h)}</th>`).join('');
  const body = rows
    .map((row) => {
      const cells = `<td>${escapeXml(row.key)}</td><td>${escapeXml(row.value)}</td>`;
      return enabled
        ? `<tr>${cells}<td>${row.enabled === false ? 'no' : 'yes'}</td></tr>`
        : `<tr>${cells}</tr>`;
    })
    .join('');
  return `<table><tbody><tr>${head}</tr>${body}</tbody></table>`;
}

function validationText(rule) {
  const tokens = validationTokens(rule);
  return tokens.length ? tokens.join(' ') : '—';
}

// Field tables carry Wapbolt-style documentation columns. Values and rules
// are escaped; descriptions may be custom error messages.
function fieldTable(rows, { enabled = false, validations = {} } = {}) {
  const headers = ['Key', 'Value'];
  if (enabled) headers.push('Enabled');
  headers.push('Validation', 'Description');
  const body = (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const rule = validations[row?.key];
      const cells = [
        `<td>${escapeXml(row?.key)}</td>`,
        `<td>${escapeXml(row?.value)}</td>`,
      ];
      if (enabled) cells.push(`<td>${row?.enabled === false ? 'no' : 'yes'}</td>`);
      cells.push(`<td>${escapeXml(validationText(rule))}</td>`);
      cells.push(`<td>${escapeXml(rule?.description || '—')}</td>`);
      return `<tr>${cells.join('')}</tr>`;
    })
    .join('');
  return `<table><tbody><tr>${headers
    .map((header) => `<th>${escapeXml(header)}</th>`)
    .join('')}</tr>${body}</tbody></table>`;
}

function prettyJson(text) {
  if (typeof text !== 'string' || !text.trim()) return text ?? '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function bodySection(body, fieldValidations) {
  const mode = body?.mode || 'none';
  if (mode === 'none') return '';
  const bodyValidations = fieldValidations?.body || {};
  const fields = bodyValidationFields(body);
  const fieldDocs = fields.length
    ? `<h3>Body fields</h3>${fieldTable(fields, { validations: bodyValidations })}`
    : '';

  if (mode === 'raw' || mode === 'json') {
    const raw = String(body?.raw ?? '');
    if (!raw.trim()) return '';
    const text = mode === 'json' ? prettyJson(raw) : raw;
    return `<h3>Body</h3>${codeMacro(text, mode === 'json' ? 'json' : 'text')}${fieldDocs}`;
  }

  if (mode === 'form-urlencoded' || mode === 'form-data') {
    const rows = Array.isArray(body?.form) ? body.form : [];
    if (!rows.length) return '';
    return `<h3>Body (${escapeXml(mode)})</h3>${fieldTable(rows, {
      enabled: true,
      validations: bodyValidations,
    })}`;
  }

  if (mode === 'graphql') {
    const query = String(body?.graphql?.query ?? '');
    const variables = String(body?.graphql?.variables ?? '');
    if (!query.trim() && !variables.trim()) return '';
    return [
      query.trim() ? `<h3>GraphQL query</h3>${codeMacro(query, 'graphql')}` : '',
      variables.trim()
        ? `<h3>GraphQL variables</h3>${codeMacro(prettyJson(variables), 'json')}${fieldDocs}`
        : '',
    ].join('');
  }

  return '';
}

function examplesSection(examples) {
  const list = Array.isArray(examples) ? examples : [];
  if (!list.length) return '';
  const items = list.map((example, index) => {
    const response = example?.response || {};
    const status = response.status != null
      ? `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
      : 'no status';
    const contentType =
      response.contentType ||
      (Array.isArray(response.headers)
        ? response.headers.find((h) => String(h?.key || '').toLowerCase() === 'content-type')?.value
        : '');
    const raw = response.body == null ? '' : String(response.body);
    const name = example?.name || `Example ${index + 1}`;
    return [
      `<h4>${escapeXml(name)} — ${escapeXml(status)}</h4>`,
      contentType ? `<p><em>${escapeXml(contentType)}</em></p>` : '',
      raw.trim()
        ? codeMacro(prettyJson(raw), 'json')
        : '<p><em>(empty body)</em></p>',
    ].join('');
  });
  return `<h3>Saved examples</h3>${items.join('')}`;
}

function variablesSection(variables) {
  const rows = Array.isArray(variables) ? variables : [];
  if (!rows.length) return '';
  return [
    '<h2>Collection variables</h2>',
    table(
      ['Key', 'Value'],
      rows.map((row) => ({
        key: row?.key,
        value: row?.type === 'secret' ? '(secret)' : row?.value,
      }))
    ),
  ].join('');
}

function requestSection(request, depth, includeExamples) {
  const method = String(request?.method || 'GET').toUpperCase();
  const level = Math.min(6, 2 + depth);
  const h = `h${level}`;
  const url = String(request?.url || '');
  const validations = normalizeFieldValidations(request?.fieldValidations);
  const pathFields = pathValidationFields(request);
  return [
    `<${h}><span style="color:${methodColor(method)};">${escapeXml(method)}</span> ${escapeXml(
      request?.name || 'Untitled Request'
    )}</${h}>`,
    url ? `<p><code>${escapeXml(url)}</code></p>` : '',
    request?.description ? `<p>${escapeXml(request.description)}</p>` : '',
    `<p><em>Auth: ${escapeXml(request?.auth?.type || 'none')}</em></p>`,
    pathFields.length
      ? `<h3>Path variables</h3>${fieldTable(pathFields, {
          validations: validations.path,
        })}`
      : '',
    Array.isArray(request?.params) && request.params.length
      ? `<h3>Query parameters</h3>${fieldTable(request.params, {
          enabled: true,
          validations: validations.params,
        })}`
      : '',
    Array.isArray(request?.headers) && request.headers.length
      ? `<h3>Headers</h3>${fieldTable(request.headers, {
          validations: validations.headers,
        })}`
      : '',
    bodySection(request?.body, validations),
    includeExamples ? examplesSection(request?.examples) : '',
  ].join('');
}

function renderItems(items, depth, includeExamples, counters) {
  const out = [];
  for (const node of Array.isArray(items) ? items : []) {
    if (!node) continue;
    if (node.type === 'folder') {
      counters.folders += 1;
      const level = Math.min(6, 2 + depth);
      out.push(
        `<h${level}>${escapeXml(node.name || 'Folder')}</h${level}>${
          node.description ? `<p>${escapeXml(node.description)}</p>` : ''
        }${renderItems(node.items, depth + 1, includeExamples, counters)}`
      );
      continue;
    }
    counters.requests += 1;
    out.push(requestSection(node, depth, includeExamples));
  }
  return out.join('');
}

function documentationSection(coll, { workspaceName, includeExamples, generatedAt }) {
  const counters = { requests: 0, folders: 0 };
  const items = renderItems(coll.items, 0, includeExamples, counters);
  const title = coll.name || 'Collection';
  const meta = [];
  if (workspaceName) meta.push(`Workspace: ${escapeXml(workspaceName)}`);
  meta.push(
    `${counters.requests} request${counters.requests === 1 ? '' : 's'} · ` +
      `${counters.folders} folder${counters.folders === 1 ? '' : 's'}`
  );
  if (generatedAt) meta.push(`Generated: ${escapeXml(generatedAt)}`);

  return [
    `<h1>${escapeXml(title)}</h1>`,
    coll.description ? `<p>${escapeXml(coll.description)}</p>` : '',
    `<p><em>${meta.join(' · ')}</em></p>`,
    '<ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">3</ac:parameter></ac:structured-macro>',
    variablesSection(coll.variables),
    items,
  ].join('');
}

function openApiSection(coll) {
  const spec = collectionToOpenApi(coll);
  return [
    '<h1>OpenAPI 3.0 Specification</h1>',
    `<p>API specification for <strong>${escapeXml(coll.name || 'Collection')}</strong> in OpenAPI 3.0 format.</p>`,
    codeMacro(JSON.stringify(spec, null, 2), 'json', { title: 'openapi.json' }),
  ].join('');
}

function swaggerSection(coll) {
  const spec = JSON.stringify(collectionToOpenApi(coll), null, 2);
  return [
    `<h1>Swagger UI - ${escapeXml(coll.name || 'Collection')}</h1>`,
    '<ac:structured-macro ac:name="swagger-open-api" ac:schema-version="1">',
    `<ac:plain-text-body>${cdata(spec)}</ac:plain-text-body>`,
    '</ac:structured-macro>',
  ].join('');
}

function sectionDivider() {
  return '<hr/><p style="text-align:center;color:#6b7280;font-size:11px;"><em>— Section break —</em></p><hr/>';
}

function attributionFooter() {
  return [
    '<hr/>',
    '<p style="text-align:center;color:#6b7280;font-size:11px;">',
    '<em>Generated by Relay — temancode</em><br/>',
    'Support: <a href="mailto:temancode@gmail.com">temancode@gmail.com</a> | ',
    'GitHub: <a href="https://github.com/abdullahPrasetio">https://github.com/abdullahPrasetio</a>',
    '</p>',
  ].join('');
}

/**
 * Build a Confluence storage-format page body for one collection.
 *
 * @param {object} collection
 * @param {{
 *   workspaceName?: string,
 *   includeExamples?: boolean,
 *   generatedAt?: string|null,
 *   contentMode?: 'documentation'|'openapi'|'swagger'|'both',
 *   contentOrder?: 'doc_first'|'openapi_first',
 * }} [options]
 * @returns {string}
 */
export function collectionToConfluenceStorage(
  collection,
  {
    workspaceName = '',
    includeExamples = true,
    generatedAt = null,
    contentMode,
    contentOrder,
  } = {}
) {
  const coll = collection || {};
  const mode = normalizeConfluenceContentMode(contentMode ?? coll.confluenceContentMode);
  const order = normalizeConfluenceContentOrder(contentOrder ?? coll.confluenceContentOrder);

  const docs = documentationSection(coll, { workspaceName, includeExamples, generatedAt });
  let body;
  if (mode === 'openapi') {
    body = openApiSection(coll);
  } else if (mode === 'swagger') {
    body = swaggerSection(coll);
  } else if (mode === 'both') {
    body =
      order === 'openapi_first'
        ? `${swaggerSection(coll)}${sectionDivider()}${docs}`
        : `${docs}${sectionDivider()}${swaggerSection(coll)}`;
  } else {
    body = docs;
  }

  return `${body}${attributionFooter()}`;
}

export function suggestConfluenceTitle(collection) {
  return String(collection?.confluenceTitle || collection?.name || 'Collection').trim();
}
