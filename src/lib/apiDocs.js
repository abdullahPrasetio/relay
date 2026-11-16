// Static HTML API documentation for a collection.
//
// Pure module: no DOM, no Electron. The returned document is a single
// self-contained HTML string with inline CSS and no scripts or external
// assets, so it can be saved and opened anywhere. Secrets are never emitted:
// `type: 'secret'` variables are rendered as `(secret)` and request auth shows
// only the scheme name.
import {
  bodyValidationFields,
  normalizeFieldValidations,
  pathValidationFields,
  validationTokens,
} from './fieldValidations.js';

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugify(value, fallback = 'section') {
  return (
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/g, '') || fallback
  );
}

function pathOf(url) {
  const raw = String(url || '').trim();
  if (!raw) return '/';
  try {
    return new URL(raw).pathname || '/';
  } catch {
    /* relative URL or path variable: fall back to the raw path */
    return raw.split(/[?#]/)[0] || '/';
  }
}

function uniqueId(base, used) {
  let id = base || 'section';
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  used.add(id);
  return id;
}

function plural(count, singular) {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

function methodClass(method) {
  const m = String(method || 'GET').toLowerCase();
  return /^[a-z]+$/.test(m) ? m : 'other';
}

function prettyJson(text) {
  if (typeof text !== 'string' || !text.trim()) return text ?? '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function headerValue(headers, name) {
  if (!Array.isArray(headers)) return '';
  const wanted = String(name || '').toLowerCase();
  const row = headers.find((h) => String(h?.key || '').toLowerCase() === wanted);
  return row?.value != null ? String(row.value) : '';
}

function validationCell(rule) {
  const tokens = validationTokens(rule);
  if (!tokens.length) return '<td class="muted">—</td>';
  return `<td>${tokens
    .map((token) => `<span class="validation-token">${escapeHtml(token)}</span>`)
    .join(' ')}</td>`;
}

function descriptionCell(rule) {
  return rule?.description
    ? `<td class="field-description">${escapeHtml(rule.description)}</td>`
    : '<td class="muted">—</td>';
}

function kvTable(rows, { enabled = false, validations = {} } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return '';
  const head = `<tr><th>Key</th><th>Value</th>${enabled ? '<th>Enabled</th>' : ''}<th>Validation</th><th>Description</th></tr>`;
  const body = list
    .map((row) => {
      const rule = validations[row?.key];
      return [
        '<tr>',
        `<td>${escapeHtml(row?.key)}</td>`,
        `<td>${escapeHtml(row?.value)}</td>`,
        enabled ? `<td>${row?.enabled === false ? 'no' : 'yes'}</td>` : '',
        validationCell(rule),
        descriptionCell(rule),
        '</tr>',
      ].join('');
    })
    .join('');
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

// Body fields are flattened (dot paths) so nested JSON and GraphQL variables
// can be documented with the same field metadata as headers and params.
function fieldTable(fields, validations = {}) {
  return kvTable(fields, { validations });
}

function renderBody(body, fieldValidations) {
  const mode = body?.mode || 'none';
  if (mode === 'none') return '';
  const bodyValidations = fieldValidations?.body || {};
  const fields = bodyValidationFields(body);
  const fieldDocs = fields.length ? `<h4>Body fields</h4>${fieldTable(fields, bodyValidations)}` : '';

  if (mode === 'raw' || mode === 'json') {
    const raw = body?.raw ?? '';
    if (!String(raw).trim()) return '';
    return [
      `<h4>Body</h4><pre>${escapeHtml(prettyJson(String(raw)))}</pre>`,
      fieldDocs,
    ].join('');
  }

  if (mode === 'form-urlencoded' || mode === 'form-data') {
    const table = kvTable(body?.form, { enabled: true, validations: bodyValidations });
    if (!table) return '';
    return `<h4>Body (${escapeHtml(mode)})</h4>${table}`;
  }

  if (mode === 'graphql') {
    const query = body?.graphql?.query ?? '';
    const variables = body?.graphql?.variables ?? '';
    if (!String(query).trim() && !String(variables).trim()) return '';
    return [
      '<h4>GraphQL query</h4>',
      `<pre>${escapeHtml(String(query))}</pre>`,
      String(variables).trim()
        ? `<h4>GraphQL variables</h4><pre>${escapeHtml(prettyJson(String(variables)))}</pre>${fieldDocs}`
        : '',
    ].join('');
  }

  return '';
}

function renderExamples(examples) {
  const list = Array.isArray(examples) ? examples : [];
  if (list.length === 0) return '';
  const items = list.map((example, index) => {
    const response = example?.response || {};
    const contentType =
      response.contentType || headerValue(response.headers, 'content-type') || '';
    const status = response.status != null
      ? `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
      : 'no status';
    const name = example?.name || `Example ${index + 1}`;
    const raw = response.body;
    const bodyText = raw == null ? '' : String(raw);
    return [
      '<div class="example">',
      `<h4>${escapeHtml(name)}</h4>`,
      `<p class="meta"><span class="status">${escapeHtml(status)}</span>`,
      contentType ? ` · ${escapeHtml(contentType)}` : '',
      '</p>',
      bodyText.trim() ? `<pre>${escapeHtml(prettyJson(bodyText))}</pre>` : '<p class="muted">(empty body)</p>',
      '</div>',
    ].join('');
  });
  return `<section class="examples"><h3>Saved examples</h3>${items.join('')}</section>`;
}

function renderRequestCard(request, id, includeExamples, resolve = (value) => value) {
  request = resolvedRequest(request, resolve);
  const authType = request?.auth?.type || 'none';
  const params = Array.isArray(request?.params) ? request.params : [];
  const headers = Array.isArray(request?.headers) ? request.headers : [];
  const method = String(request?.method || 'GET').toUpperCase();
  const url = request?.url || '';
  const validations = normalizeFieldValidations(request?.fieldValidations);
  const pathFields = pathValidationFields(request);

  return [
    `<article class="request" id="${escapeHtml(id)}">`,
    `<header class="request-head">`,
    `<span class="method method-${escapeHtml(methodClass(method))}">${escapeHtml(method)}</span>`,
    `<h3>${escapeHtml(request?.name || 'Untitled Request')}</h3>`,
    '</header>',
    url ? `<p class="url"><code>${escapeHtml(url)}</code></p>` : '',
    request?.description
      ? `<p class="description">${escapeHtml(request.description)}</p>`
      : '',
    `<p class="auth">Auth: <code>${escapeHtml(authType)}</code></p>`,
    pathFields.length
      ? `<h4>Path variables</h4>${kvTable(pathFields, {
          validations: validations.path,
        })}`
      : '',
    params.length
      ? `<h4>Query parameters</h4>${kvTable(params, {
          enabled: true,
          validations: validations.params,
        })}`
      : '',
    headers.length
      ? `<h4>Headers</h4>${kvTable(headers, { validations: validations.headers })}`
      : '',
    renderBody(request?.body, validations),
    includeExamples ? renderExamples(request?.examples) : '',
    '</article>',
  ].join('');
}

function renderVariables(variables) {
  const rows = Array.isArray(variables) ? variables : [];
  if (rows.length === 0) return '';
  const body = rows
    .map((row) => {
      const value = row?.type === 'secret' ? '(secret)' : row?.value;
      return `<tr><td>${escapeHtml(row?.key)}</td><td>${escapeHtml(value)}</td></tr>`;
    })
    .join('');
  return [
    '<section class="variables" id="collection-variables">',
    '<h2>Collection variables</h2>',
    '<table><thead><tr><th>Key</th><th>Value</th></tr></thead>',
    `<tbody>${body}</tbody></table>`,
    '</section>',
  ].join('');
}

const LABELS = {
  en: {
    preparedBy: 'Prepared by',
    preparedFor: 'Prepared for',
    organization: 'Organization',
    version: 'Version',
    classification: 'Classification',
    generated: 'Generated',
    workspace: 'Workspace',
    disclaimer: 'Disclaimer',
    generatedBy: 'Generated by Relay',
    resolvedFrom: 'Variables resolved from',
    appendix: 'Collection appendix',
    summary: 'Collection summary',
    definition: 'Collection definition (JSON)',
    watermarkPreparedBy: 'Prepared by',
    watermarkFor: 'For',
  },
  id: {
    preparedBy: 'Disusun oleh',
    preparedFor: 'Ditujukan untuk',
    organization: 'Organisasi',
    version: 'Versi',
    classification: 'Klasifikasi',
    generated: 'Dibuat pada',
    workspace: 'Workspace',
    disclaimer: 'Penafian',
    generatedBy: 'Dibuat dengan Relay',
    resolvedFrom: 'Variabel di-resolve dari',
    appendix: 'Lampiran collection',
    summary: 'Ringkasan collection',
    definition: 'Definisi collection (JSON)',
    watermarkPreparedBy: 'Disusun oleh',
    watermarkFor: 'Untuk',
  },
};

function labelsFor(language) {
  return LABELS[language] || LABELS.en;
}

function accentHex(value) {
  const text = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text : '#6366f1';
}

const TOKEN_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

function safeVariableMap(source) {
  const map = {};
  const list = Array.isArray(source) ? source : source?.variables;
  for (const row of Array.isArray(list) ? list : []) {
    if (!row || row.enabled === false || !row.key || row.type === 'secret') continue;
    map[row.key] = row.value ?? '';
  }
  return map;
}

function resolveTokens(value, vars) {
  if (typeof value !== 'string' || !value) return value;
  return value.replace(TOKEN_RE, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
  );
}

function resolvedRequest(request, resolve) {
  if (!request) return request;
  const body = request.body;
  return {
    ...request,
    url: resolve(request.url),
    description: resolve(request.description),
    params: (request.params || []).map((row) => ({
      ...row,
      key: resolve(row?.key),
      value: resolve(row?.value),
    })),
    headers: (request.headers || []).map((row) => ({
      ...row,
      key: resolve(row?.key),
      value: resolve(row?.value),
    })),
    pathVars: (request.pathVars || []).map((row) => ({
      ...row,
      key: resolve(row?.key),
      value: resolve(row?.value),
    })),
    body: body
      ? {
          ...body,
          raw: resolve(body.raw),
          form: (body.form || []).map((row) => ({
            ...row,
            key: resolve(row?.key),
            value: resolve(row?.value),
          })),
          graphql: body.graphql
            ? {
                ...body.graphql,
                query: resolve(body.graphql.query),
                variables: resolve(body.graphql.variables),
              }
            : body.graphql,
        }
      : body,
  };
}

function redactCollection(collection) {
  const clone = JSON.parse(JSON.stringify(collection || {}));
  const sensitiveKey = /(authorization|token|secret|password|passphrase|api[-_]?key|client[-_]?secret|private[-_]?key)/i;

  function redactNode(node) {
    if (Array.isArray(node)) {
      for (const item of node) redactNode(item);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'variables' && Array.isArray(value)) {
        for (const row of value) {
          if (row?.type === 'secret') row.value = '••••';
        }
        continue;
      }
      if (
        (key === 'headers' || key === 'params' || key === 'pathVars' || key === 'form') &&
        Array.isArray(value)
      ) {
        for (const row of value) {
          if (row && sensitiveKey.test(String(row.key || ''))) row.value = '••••';
        }
        continue;
      }
      if (sensitiveKey.test(key) && typeof value === 'string') {
        node[key] = value ? '••••' : value;
        continue;
      }
      redactNode(value);
    }
  }

  redactNode(clone);
  return clone;
}

function renderSummaryItems(items, depth = 0) {
  const out = [];
  for (const node of Array.isArray(items) ? items : []) {
    if (!node) continue;
    if (node.type === 'folder') {
      out.push(
        `<li class="appendix-folder" style="--depth:${Math.min(depth, 6)}"><strong>${escapeHtml(
          node.name || 'Folder'
        )}</strong>${renderSummaryItems(node.items, depth + 1)}</li>`
      );
      continue;
    }
    out.push(
      `<li class="appendix-request" style="--depth:${Math.min(depth, 6)}"><span class="method method-${escapeHtml(
        methodClass(node.method)
      )}">${escapeHtml(String(node.method || 'GET').toUpperCase())}</span> ${escapeHtml(
        node.name || 'Untitled Request'
      )}</li>`
    );
  }
  return out.length ? `<ul class="appendix-tree">${out.join('')}</ul>` : '';
}

function renderAppendix(collection, { includeSummary, includeJson, labels }) {
  if (!includeSummary && !includeJson) return '';
  const summary = includeSummary
    ? `<h3>${escapeHtml(labels.summary)}</h3>${renderSummaryItems(collection.items)}`
    : '';
  const definition = includeJson
    ? `<h3>${escapeHtml(labels.definition)}</h3><pre>${escapeHtml(
        JSON.stringify(redactCollection(collection), null, 2)
      )}</pre>`
    : '';
  return `<section class="appendix"><h2>${escapeHtml(labels.appendix)}</h2>${summary}${definition}</section>`;
}

const STYLE = `
  :root {
    color-scheme: light;
    --bg: #f6f7f9;
    --surface: #ffffff;
    --surface-2: #eef1f5;
    --text: #1d2433;
    --muted: #5b6475;
    --border: #dde1e7;
    --border-soft: #e5e8ee;
    --code: #f3f5f8;
    --accent: #6366f1;
    --accent-contrast: #ffffff;
  }
  html[data-theme='dark'] {
    color-scheme: dark;
    --bg: #0f1115;
    --surface: #161a21;
    --surface-2: #1e2430;
    --text: #e6e9ef;
    --muted: #8b93a3;
    --border: #262c38;
    --border-soft: #2b3340;
    --code: #12151b;
    --accent: #8b9cff;
    --accent-contrast: #0f1115;
  }
  html[data-theme='system'] { color-scheme: light; }
  @media (prefers-color-scheme: dark) {
    html[data-theme='system'] {
      color-scheme: dark;
      --bg: #0f1115;
      --surface: #161a21;
      --surface-2: #1e2430;
      --text: #e6e9ef;
      --muted: #8b93a3;
      --border: #262c38;
      --border-soft: #2b3340;
      --code: #12151b;
      --accent: #8b9cff;
      --accent-contrast: #0f1115;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2rem; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--text); background: var(--bg); }
  .docs { max-width: 960px; margin: 0 auto; }
  header.docs-header { background: var(--surface); border: 1px solid var(--border); border-top: 4px solid var(--accent); border-radius: 10px; padding: 1.5rem; margin-bottom: 1.5rem; }
  header.docs-header h1 { margin: 0 0 .25rem; font-size: 1.75rem; }
  .docs-meta { color: var(--muted); font-size: .9rem; margin: .25rem 0 0; }
  .description { white-space: pre-wrap; }
  .doc-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: .6rem 1.2rem; margin: 1rem 0 0; padding-top: .9rem; border-top: 1px solid var(--border-soft); }
  .doc-meta dt { color: var(--muted); font-size: .72rem; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
  .doc-meta dd { margin: .15rem 0 0; font-size: .92rem; }
  .toc, .variables, .folder, .request { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
  .toc h2, .variables h2 { margin-top: 0; }
  .toc ul { list-style: none; margin: 0; padding: 0; }
  .toc li { padding: .15rem 0; }
  .toc a { color: var(--accent); text-decoration: none; }
  .toc a:hover { text-decoration: underline; }
  .toc .toc-folder a { font-weight: 600; color: var(--text); }
  .toc .depth-1 { padding-left: 1rem; }
  .toc .depth-2 { padding-left: 2rem; }
  .toc .depth-3 { padding-left: 3rem; }
  .folder { background: var(--surface-2); padding-bottom: .5rem; }
  .folder > h2 { margin: .25rem 0 .75rem; font-size: 1.1rem; }
  .request { background: var(--surface); }
  .request-head { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
  .request-head h3 { margin: 0; font-size: 1.05rem; }
  .method { display: inline-block; min-width: 4.2rem; text-align: center; padding: .1rem .45rem; border-radius: 4px; font: 700 11px/1.6 ui-monospace, monospace; letter-spacing: .03em; color: #fff; background: #6b7280; }
  .method-get { background: #2f7d32; }
  .method-post { background: #a35c00; }
  .method-put { background: #1f5fbf; }
  .method-patch { background: #7c3aed; }
  .method-delete { background: #b3261e; }
  .method-head, .method-options { background: #4b5563; }
  .url code { word-break: break-all; font-size: .9rem; }
  .auth { color: var(--muted); margin: .4rem 0; }
  h4 { margin: .9rem 0 .35rem; font-size: .85rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  table { width: 100%; border-collapse: collapse; font-size: .9rem; }
  th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid var(--border-soft); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; }
  pre { background: var(--code); border: 1px solid var(--border); border-radius: 6px; padding: .75rem; overflow: auto; font-size: .85rem; white-space: pre-wrap; word-break: break-word; }
  .example { margin-top: .75rem; padding-top: .75rem; border-top: 1px dashed var(--border); }
  .example h4 { margin-top: 0; text-transform: none; letter-spacing: 0; font-size: .95rem; color: var(--text); }
  .status { font-weight: 600; }
  .validation-token { display: inline-block; margin: 0 .2rem .15rem 0; padding: .05rem .3rem; border: 1px solid var(--border); border-radius: 3px; font-size: .7rem; font-weight: 600; letter-spacing: .02em; color: var(--muted); }
  .field-description { white-space: pre-wrap; }
  .meta, .muted { color: var(--muted); font-size: .85rem; }
  .disclaimer { background: var(--surface); border: 1px solid var(--border); border-left: 4px solid var(--accent); border-radius: 8px; padding: 1rem 1.25rem; margin: 1.5rem 0 1rem; }
  .disclaimer h2 { margin: 0 0 .4rem; font-size: 1rem; }
  .disclaimer p { margin: 0; color: var(--muted); font-size: .86rem; white-space: pre-wrap; }
  footer.docs-footer { color: var(--muted); font-size: .8rem; text-align: center; margin-top: 2rem; }
  .template-professional header.docs-header { padding: 2rem; background: var(--surface-2); border-top: 6px solid var(--accent); }
  .template-professional header.docs-header h1 { font-size: 2.1rem; letter-spacing: -.02em; }
  .template-professional .doc-meta { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: .9rem 1rem; }
  body.template-minimal { background: var(--surface); }
  .template-minimal .docs { max-width: 860px; }
  .template-minimal header.docs-header,
  .template-minimal .toc,
  .template-minimal .variables,
  .template-minimal .folder,
  .template-minimal .request { background: transparent; border: 0; border-bottom: 1px solid var(--border); border-radius: 0; padding: 0 0 1.1rem; margin-bottom: 1.1rem; }
  .template-minimal header.docs-header { border-bottom: 2px solid var(--border); padding-bottom: 1.4rem; }
  .template-minimal .disclaimer { border: 1px solid var(--border); border-left: 3px solid var(--accent); }
  .docs { position: relative; z-index: 1; }
  .watermark-layer {
    position: fixed;
    inset: 0;
    z-index: 2;
    overflow: hidden;
    pointer-events: none;
    user-select: none;
  }
  .watermark {
    position: absolute;
    color: var(--text);
    opacity: .045;
    font-size: clamp(20px, 3.2vw, 46px);
    font-weight: 800;
    letter-spacing: .08em;
    white-space: nowrap;
    transform: rotate(-28deg);
  }
  .watermark-1 { left: 2%; top: 12%; }
  .watermark-2 { left: 38%; top: 10%; }
  .watermark-3 { left: 74%; top: 12%; }
  .watermark-4 { left: 2%; top: 55%; }
  .watermark-5 { left: 38%; top: 53%; }
  .watermark-6 { left: 74%; top: 55%; }
  .appendix h2 { margin-top: 0; }
  .appendix h3 { margin: 1rem 0 .4rem; font-size: .9rem; }
  .appendix-tree { list-style: none; margin: 0; padding: 0; }
  .appendix-tree li { padding: .2rem 0 .2rem calc(var(--depth, 0) * 1.1rem); }
  .appendix-folder strong { font-size: .92rem; }
  .appendix-request { color: var(--muted); }
  .appendix-request .method { min-width: 3.5rem; margin-right: .25rem; }
  @page { size: A4; margin: 14mm; }
  @media print {
    body { background: #fff; color: #000; padding: 0; }
    .docs { max-width: none; }
    header.docs-header, .toc, .variables, .folder, .request, .disclaimer { break-inside: avoid; border-color: #ccc; }
    .toc a { color: #000; }
    body.template-minimal { background: #fff; }
  }
`;

export function collectionToHtml(
  collection,
  {
    workspaceName = '',
    generatedAt = new Date().toISOString(),
    includeExamples = true,
    template = 'classic',
    theme = 'light',
    accent = '#6366f1',
    documentTitle = '',
    author = '',
    preparedFor = '',
    organization = '',
    version = '',
    classification = '',
    disclaimer = '',
    language = 'en',
    resolveVariables = false,
    environment = null,
    globals = [],
    watermark = false,
    watermarkText = '',
    includeCollectionSummary = false,
    includeCollectionJson = false,
  } = {}
) {
  const coll = collection || {};
  const labels = labelsFor(language);
  const lang = language === 'id' ? 'id' : 'en';
  const safeTemplate = ['classic', 'professional', 'minimal'].includes(template)
    ? template
    : 'classic';
  const safeTheme = ['light', 'dark', 'system'].includes(theme) ? theme : 'light';
  const safeAccent = accentHex(accent);
  const themeAttr = safeTheme === 'light' ? '' : ` data-theme="${safeTheme}"`;
  const accentAttr =
    safeTheme === 'light' && safeAccent.toLowerCase() === '#6366f1'
      ? ''
      : ` style="--accent: ${safeAccent}"`;
  const scope = {
    ...safeVariableMap(globals),
    ...safeVariableMap(coll.variables),
    ...safeVariableMap(environment?.variables),
  };
  const resolve = resolveVariables
    ? (value) => resolveTokens(value, scope)
    : (value) => value;
  const used = new Set(['collection-variables']);
  const toc = [];
  let requestCount = 0;
  let folderCount = 0;

  function renderItems(items, depth) {
    const out = [];
    for (const node of Array.isArray(items) ? items : []) {
      if (!node) continue;
      if (node.type === 'folder') {
        folderCount += 1;
        const id = uniqueId(`folder-${slugify(node.name)}`, used);
        toc.push(
          `<li class="toc-folder depth-${Math.min(depth, 3)}"><a href="#${escapeHtml(id)}">${escapeHtml(
            node.name || 'Folder'
          )}</a></li>`
        );
        const children = renderItems(node.items, depth + 1);
        out.push(
          `<section class="folder" id="${escapeHtml(id)}"><h2>${escapeHtml(
            node.name || 'Folder'
          )}</h2>${
            node.description ? `<p class="description">${escapeHtml(node.description)}</p>` : ''
          }${children}</section>`
        );
        continue;
      }

      requestCount += 1;
      const method = String(node.method || 'GET').toUpperCase();
      const id = uniqueId(
        `req-${slugify(`${method}-${pathOf(node.url)}-${node.name || ''}`)}`,
        used
      );
      toc.push(
        `<li class="toc-request depth-${Math.min(depth, 3)}"><a href="#${escapeHtml(id)}">${escapeHtml(
          method
        )} ${escapeHtml(node.name || 'Untitled Request')}</a></li>`
      );
      out.push(renderRequestCard(node, id, includeExamples, resolve));
    }
    return out.join('\n');
  }

  const requestSections = renderItems(coll.items, 0);
  if (Array.isArray(coll.variables) && coll.variables.length > 0) {
    toc.unshift(
      '<li class="toc-variables"><a href="#collection-variables">Collection variables</a></li>'
    );
  }

  const heading = documentTitle || coll.name || 'Collection';
  const title = `${heading} — API docs`;
  const counts = `${plural(requestCount, 'request')} · ${plural(folderCount, 'folder')}`;
  const generated = generatedAt
    ? `<p class="docs-meta">${escapeHtml(labels.generated)} ${escapeHtml(generatedAt)}</p>`
    : '';
  const meta = [
    [labels.preparedBy, author],
    [labels.preparedFor, preparedFor],
    [labels.organization, organization],
    [labels.version, version],
    [labels.classification, classification],
  ]
    .filter(([, value]) => String(value || '').trim())
    .map(
      ([label, value]) =>
        `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`
    )
    .join('');
  const metaSection = meta ? `<dl class="doc-meta">${meta}</dl>` : '';
  const disclaimerSection = String(disclaimer || '').trim()
    ? `<section class="disclaimer"><h2>${escapeHtml(labels.disclaimer)}</h2><p>${escapeHtml(
        disclaimer
      )}</p></section>`
    : '';
  const watermarkLabel = watermark
    ? String(watermarkText || '').trim() ||
      [author && `${labels.watermarkPreparedBy} ${author}`, preparedFor && `${labels.watermarkFor} ${preparedFor}`, classification]
        .filter(Boolean)
        .join(' • ') ||
      'Relay documentation'
    : '';
  const watermarkHtml = watermarkLabel
    ? `<div class="watermark-layer" aria-hidden="true">${Array.from(
        { length: 6 },
        (_, index) =>
          `<span class="watermark watermark-${index + 1}">${escapeHtml(
            watermarkLabel
          )}</span>`
      ).join('')}</div>`
    : '';
  const resolvedFrom =
    resolveVariables && environment?.name
      ? `<p class="docs-meta">${escapeHtml(labels.resolvedFrom)}: ${escapeHtml(
          environment.name
        )}</p>`
      : '';
  const appendix = renderAppendix(coll, {
    includeSummary: includeCollectionSummary,
    includeJson: includeCollectionJson,
    labels,
  });

  return `<!doctype html>
<html lang="${lang}"${themeAttr}${accentAttr}>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body class="docs-page template-${safeTemplate}">
${watermarkHtml}
<div class="docs">
<header class="docs-header">
<h1>${escapeHtml(heading)}</h1>
${coll.description ? `<p class="description">${escapeHtml(coll.description)}</p>` : ''}
${metaSection}
${workspaceName ? `<p class="docs-meta">${escapeHtml(labels.workspace)}: ${escapeHtml(workspaceName)}</p>` : ''}
${generated}
${resolvedFrom}
<p class="docs-meta">${escapeHtml(counts)}</p>
</header>
<nav class="toc">
<h2>Contents</h2>
${toc.length ? `<ul>${toc.join('')}</ul>` : '<p class="muted">No requests in this collection.</p>'}
</nav>
${renderVariables(coll.variables)}
${requestSections}
${appendix}
${disclaimerSection}
<footer class="docs-footer">${escapeHtml(labels.generatedBy)}</footer>
</div>
</body>
</html>
`;
}

export function suggestDocsName(collection) {
  return `${slugify(collection?.name || '', 'collection')}-docs.html`;
}
