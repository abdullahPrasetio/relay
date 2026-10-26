// Static HTML API documentation for a collection.
//
// Pure module: no DOM, no Electron. The returned document is a single
// self-contained HTML string with inline CSS and no scripts or external
// assets, so it can be saved and opened anywhere. Secrets are never emitted:
// `type: 'secret'` variables are rendered as `(secret)` and request auth shows
// only the scheme name.

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

function kvTable(rows, { enabled = false } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return '';
  const head = enabled
    ? '<tr><th>Key</th><th>Value</th><th>Enabled</th></tr>'
    : '<tr><th>Key</th><th>Value</th></tr>';
  const body = list
    .map((row) => {
      const cells = `<td>${escapeHtml(row?.key)}</td><td>${escapeHtml(row?.value)}</td>`;
      return enabled
        ? `<tr>${cells}<td>${row?.enabled === false ? 'no' : 'yes'}</td></tr>`
        : `<tr>${cells}</tr>`;
    })
    .join('');
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function renderBody(body) {
  const mode = body?.mode || 'none';
  if (mode === 'none') return '';

  if (mode === 'raw' || mode === 'json') {
    const raw = body?.raw ?? '';
    if (!String(raw).trim()) return '';
    return `<h4>Body</h4><pre>${escapeHtml(prettyJson(String(raw)))}</pre>`;
  }

  if (mode === 'form-urlencoded' || mode === 'form-data') {
    const table = kvTable(body?.form, { enabled: true });
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
        ? `<h4>GraphQL variables</h4><pre>${escapeHtml(prettyJson(String(variables)))}</pre>`
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

function renderRequestCard(request, id, includeExamples) {
  const authType = request?.auth?.type || 'none';
  const params = Array.isArray(request?.params) ? request.params : [];
  const headers = Array.isArray(request?.headers) ? request.headers : [];
  const method = String(request?.method || 'GET').toUpperCase();
  const url = request?.url || '';

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
    params.length ? `<h4>Query parameters</h4>${kvTable(params, { enabled: true })}` : '',
    headers.length ? `<h4>Headers</h4>${kvTable(headers)}` : '',
    renderBody(request?.body),
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

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2rem; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1d2433; background: #f6f7f9; }
  .docs { max-width: 960px; margin: 0 auto; }
  header.docs-header { background: #fff; border: 1px solid #dde1e7; border-radius: 10px; padding: 1.5rem; margin-bottom: 1.5rem; }
  header.docs-header h1 { margin: 0 0 .25rem; font-size: 1.75rem; }
  .docs-meta { color: #5b6475; font-size: .9rem; margin: .25rem 0 0; }
  .description { white-space: pre-wrap; }
  .toc, .variables, .folder, .request { background: #fff; border: 1px solid #dde1e7; border-radius: 10px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
  .toc h2, .variables h2 { margin-top: 0; }
  .toc ul { list-style: none; margin: 0; padding: 0; }
  .toc li { padding: .15rem 0; }
  .toc a { color: #1f5fbf; text-decoration: none; }
  .toc a:hover { text-decoration: underline; }
  .toc .toc-folder a { font-weight: 600; color: #374151; }
  .toc .depth-1 { padding-left: 1rem; }
  .toc .depth-2 { padding-left: 2rem; }
  .toc .depth-3 { padding-left: 3rem; }
  .folder { background: #eef1f5; padding-bottom: .5rem; }
  .folder > h2 { margin: .25rem 0 .75rem; font-size: 1.1rem; }
  .request { background: #fff; }
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
  .auth { color: #5b6475; margin: .4rem 0; }
  h4 { margin: .9rem 0 .35rem; font-size: .85rem; text-transform: uppercase; letter-spacing: .04em; color: #5b6475; }
  table { width: 100%; border-collapse: collapse; font-size: .9rem; }
  th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid #e5e8ee; vertical-align: top; }
  th { color: #5b6475; font-weight: 600; }
  pre { background: #f3f5f8; border: 1px solid #e1e5eb; border-radius: 6px; padding: .75rem; overflow: auto; font-size: .85rem; white-space: pre-wrap; word-break: break-word; }
  .example { margin-top: .75rem; padding-top: .75rem; border-top: 1px dashed #dde1e7; }
  .example h4 { margin-top: 0; text-transform: none; letter-spacing: 0; font-size: .95rem; color: #1d2433; }
  .status { font-weight: 600; }
  .meta, .muted { color: #5b6475; font-size: .85rem; }
  footer.docs-footer { color: #5b6475; font-size: .8rem; text-align: center; margin-top: 2rem; }
`;

export function collectionToHtml(
  collection,
  { workspaceName = '', generatedAt = new Date().toISOString(), includeExamples = true } = {}
) {
  const coll = collection || {};
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
      out.push(renderRequestCard(node, id, includeExamples));
    }
    return out.join('\n');
  }

  const requestSections = renderItems(coll.items, 0);
  if (Array.isArray(coll.variables) && coll.variables.length > 0) {
    toc.unshift(
      '<li class="toc-variables"><a href="#collection-variables">Collection variables</a></li>'
    );
  }

  const title = `${coll.name || 'Collection'} — API docs`;
  const counts = `${plural(requestCount, 'request')} · ${plural(folderCount, 'folder')}`;
  const generated = generatedAt ? `<p class="docs-meta">Generated ${escapeHtml(generatedAt)}</p>` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="docs">
<header class="docs-header">
<h1>${escapeHtml(coll.name || 'Collection')}</h1>
${coll.description ? `<p class="description">${escapeHtml(coll.description)}</p>` : ''}
${workspaceName ? `<p class="docs-meta">Workspace: ${escapeHtml(workspaceName)}</p>` : ''}
${generated}
<p class="docs-meta">${escapeHtml(counts)}</p>
</header>
<nav class="toc">
<h2>Contents</h2>
${toc.length ? `<ul>${toc.join('')}</ul>` : '<p class="muted">No requests in this collection.</p>'}
</nav>
${renderVariables(coll.variables)}
${requestSections}
<footer class="docs-footer">Generated by Relay</footer>
</div>
</body>
</html>
`;
}

export function suggestDocsName(collection) {
  return `${slugify(collection?.name || '', 'collection')}-docs.html`;
}
