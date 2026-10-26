// Generate a cURL command from a (already variable-resolved) request.
// Mirrors how Postman's "Code" panel produces a copy-pasteable curl.
// Uses the global URL (available in both the renderer and Node).

function shellQuote(s) {
  // Wrap in single quotes, escaping embedded single quotes.
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function buildUrl(request) {
  let urlString = (request.url || '').trim();
  if (!/^https?:\/\//i.test(urlString)) urlString = 'https://' + urlString;
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return urlString; // fall back to raw text if not parseable
  }
  for (const p of request.params || []) {
    if (p && p.enabled !== false && p.key) url.searchParams.append(p.key, p.value ?? '');
  }
  return url.toString();
}

function authHeaderLines(auth) {
  const lines = [];
  if (!auth || auth.type === 'none') return lines;
  if (auth.type === 'bearer' && auth.bearer?.token) {
    lines.push(['Authorization', `Bearer ${auth.bearer.token}`]);
  } else if (auth.type === 'basic') {
    const u = auth.basic?.username ?? '';
    const p = auth.basic?.password ?? '';
    // Renderer-only code: btoa is always available here.
    const enc = btoa(`${u}:${p}`);
    lines.push(['Authorization', `Basic ${enc}`]);
  } else if (auth.type === 'apikey' && auth.apikey?.key && auth.apikey.addTo === 'header') {
    lines.push([auth.apikey.key, auth.apikey.value ?? '']);
  } else if (auth.type === 'oauth2' && auth.oauth2?.accessToken) {
    const prefix = auth.oauth2.headerPrefix || 'Bearer';
    lines.push(['Authorization', `${prefix} ${auth.oauth2.accessToken}`.trim()]);
  }
  return lines;
}

export function toCurl(request) {
  const method = (request.method || 'GET').toUpperCase();
  const url = buildUrl(request);
  const parts = [`curl --location --request ${method} ${shellQuote(url)}`];

  // Headers (explicit + auth)
  const headerPairs = [];
  for (const h of request.headers || []) {
    if (h && h.enabled !== false && h.key) headerPairs.push([h.key, h.value ?? '']);
  }
  for (const pair of authHeaderLines(request.auth)) headerPairs.push(pair);

  // Body
  const body = request.body || { mode: 'none' };
  let bodyArgs = [];
  if (body.mode === 'json') {
    if (!headerPairs.some(([k]) => k.toLowerCase() === 'content-type')) {
      headerPairs.push(['Content-Type', 'application/json']);
    }
    bodyArgs.push(`--data-raw ${shellQuote(body.raw || '')}`);
  } else if (body.mode === 'raw') {
    bodyArgs.push(`--data-raw ${shellQuote(body.raw || '')}`);
  } else if (body.mode === 'form-urlencoded') {
    for (const f of body.form || []) {
      if (f && f.enabled !== false && f.key) {
        bodyArgs.push(`--data-urlencode ${shellQuote(`${f.key}=${f.value ?? ''}`)}`);
      }
    }
  } else if (body.mode === 'form-data') {
    for (const f of body.form || []) {
      if (f && f.enabled !== false && f.key) {
        bodyArgs.push(`--form ${shellQuote(`${f.key}=${f.value ?? ''}`)}`);
      }
    }
  }

  for (const [k, v] of headerPairs) {
    parts.push(`--header ${shellQuote(`${k}: ${v}`)}`);
  }
  parts.push(...bodyArgs);

  return parts.join(' \\\n  ');
}

// Collect explicit + auth headers (auto content-type for json) as pairs.
function collectHeaders(request) {
  const pairs = [];
  for (const h of request.headers || []) {
    if (h && h.enabled !== false && h.key) pairs.push([h.key, h.value ?? '']);
  }
  for (const pair of authHeaderLines(request.auth)) pairs.push(pair);
  const body = request.body || { mode: 'none' };
  if (body.mode === 'json' && !pairs.some(([k]) => k.toLowerCase() === 'content-type')) {
    pairs.push(['Content-Type', 'application/json']);
  }
  return pairs;
}

function jsString(s) {
  return JSON.stringify(String(s));
}

function pyString(s) {
  return JSON.stringify(String(s)); // JSON strings are valid Python strings
}

// ---- JavaScript (fetch) ----
export function toFetch(request) {
  const method = (request.method || 'GET').toUpperCase();
  const url = buildUrl(request);
  const headers = collectHeaders(request);
  const body = request.body || { mode: 'none' };

  const lines = [];
  const headerObj = headers.length
    ? '{\n' + headers.map(([k, v]) => `    ${jsString(k)}: ${jsString(v)}`).join(',\n') + '\n  }'
    : '{}';

  let bodyLine = '';
  if (body.mode === 'json' || body.mode === 'raw') {
    bodyLine = `  body: ${jsString(body.raw || '')},\n`;
  } else if (body.mode === 'form-urlencoded') {
    const pairs = (body.form || [])
      .filter((f) => f.enabled !== false && f.key)
      .map((f) => `${encodeURIComponent(f.key)}=${encodeURIComponent(f.value ?? '')}`)
      .join('&');
    bodyLine = `  body: ${jsString(pairs)},\n`;
  } else if (body.mode === 'form-data') {
    lines.push('const form = new FormData();');
    for (const f of body.form || []) {
      if (f.enabled !== false && f.key) {
        lines.push(`form.append(${jsString(f.key)}, ${jsString(f.value ?? '')});`);
      }
    }
    bodyLine = '  body: form,\n';
  }

  lines.push(
    `const res = await fetch(${jsString(url)}, {\n` +
      `  method: ${jsString(method)},\n` +
      `  headers: ${headerObj},\n` +
      bodyLine +
      `});\n` +
      `const data = await res.text();\n` +
      `console.log(res.status, data);`
  );
  return lines.join('\n');
}

// ---- Python (requests) ----
export function toPython(request) {
  const method = (request.method || 'GET').toLowerCase();
  const url = buildUrl(request);
  const headers = collectHeaders(request);
  const body = request.body || { mode: 'none' };

  const lines = ['import requests', ''];
  const headerDict =
    headers.length
      ? '{\n' + headers.map(([k, v]) => `    ${pyString(k)}: ${pyString(v)}`).join(',\n') + '\n}'
      : '{}';
  lines.push(`headers = ${headerDict}`);

  let callArgs = `${pyString(url)}, headers=headers`;
  if (body.mode === 'json') {
    lines.push(`payload = ${body.raw || '{}'}`);
    callArgs += ', json=payload';
  } else if (body.mode === 'raw') {
    lines.push(`payload = ${pyString(body.raw || '')}`);
    callArgs += ', data=payload';
  } else if (body.mode === 'form-urlencoded' || body.mode === 'form-data') {
    const entries = (body.form || [])
      .filter((f) => f.enabled !== false && f.key)
      .map((f) => `    ${pyString(f.key)}: ${pyString(f.value ?? '')}`)
      .join(',\n');
    lines.push(`data = {\n${entries}\n}`);
    callArgs += body.mode === 'form-data' ? ', files=data' : ', data=data';
  }

  lines.push('', `response = requests.${method}(${callArgs})`, 'print(response.status_code)', 'print(response.text)');
  return lines.join('\n');
}

// ---- HTTPie ----
export function toHttpie(request) {
  const method = (request.method || 'GET').toUpperCase();
  const url = buildUrl(request);
  const headers = collectHeaders(request);
  const body = request.body || { mode: 'none' };

  const parts = ['http', method, shellQuote(url)];
  for (const [k, v] of headers) parts.push(shellQuote(`${k}:${v}`));

  if (body.mode === 'json') {
    // HTTPie reads raw JSON from stdin for complex bodies.
    return `echo ${shellQuote(body.raw || '{}')} | ${parts.join(' ')}`;
  }
  if (body.mode === 'raw') {
    return `echo ${shellQuote(body.raw || '')} | ${parts.join(' ')}`;
  }
  if (body.mode === 'form-urlencoded' || body.mode === 'form-data') {
    if (body.mode === 'form-data') parts.push('--form');
    for (const f of body.form || []) {
      if (f.enabled !== false && f.key) parts.push(shellQuote(`${f.key}=${f.value ?? ''}`));
    }
  }
  return parts.join(' ');
}

export const GENERATORS = {
  curl: { label: 'cURL', fn: toCurl },
  fetch: { label: 'JavaScript (fetch)', fn: toFetch },
  python: { label: 'Python (requests)', fn: toPython },
  httpie: { label: 'HTTPie', fn: toHttpie },
};

export function generateCode(lang, request) {
  const gen = GENERATORS[lang] || GENERATORS.curl;
  return gen.fn(normalizeForCodegen(request));
}

// GraphQL bodies serialize to a JSON {query,variables} payload, so code
// generators (which know json/raw/form) can treat them as a JSON body.
function normalizeForCodegen(request) {
  const b = request.body;
  if (b && b.mode === 'graphql') {
    let variables = {};
    try {
      if (b.graphql?.variables?.trim()) variables = JSON.parse(b.graphql.variables);
    } catch {
      /* ignore invalid variables JSON */
    }
    const raw = JSON.stringify({ query: b.graphql?.query || '', variables });
    return { ...request, body: { mode: 'json', raw, form: [] } };
  }
  return request;
}
