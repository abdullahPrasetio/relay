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

// ---- Additional language targets ----
//
// Every generator below is a pure `(request) => string` function. Requests
// arrive already variable-resolved, with auth applied as headers and GraphQL
// bodies normalized to JSON. They all share the same body model:
//   none | raw | json | form-urlencoded | form-data
//
// Multipart policy: multipart/form-data bodies are never synthesized. File
// fields carry a path, not bytes, so a generator that inlined them would dump
// binary data and would also need a multipart implementation per language.
// Instead each generator documents the fields in language comments and leaves
// body construction to the reader. Methods that require a body (POST/PUT/
// PATCH in OkHttp) get an empty body so the emitted code still compiles.

function commentSafe(s) {
  return String(s).replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

function formEntries(request) {
  return (request.body?.form || []).filter((f) => f && f.enabled !== false && f.key);
}

function isFileField(field) {
  return field.type === 'file';
}

function filePlaceholder(field) {
  // Never read the file: the path (or a stable placeholder) is all we emit.
  return field.filePath || `/path/to/${field.fileName || field.key || 'file'}`;
}

function formUrlEncoded(request) {
  return formEntries(request)
    .filter((f) => !isFileField(f))
    .map((f) => `${encodeURIComponent(f.key)}=${encodeURIComponent(f.value ?? '')}`)
    .join('&');
}

// Like collectHeaders, but also infers Content-Type for form-urlencoded bodies
// and reports the resolved content type for APIs that set it themselves.
// collectHeaders stays untouched so the older targets remain byte-identical.
function collectHeaderInfo(request) {
  const pairs = [];
  for (const h of request.headers || []) {
    if (h && h.enabled !== false && h.key) pairs.push([h.key, h.value ?? '']);
  }
  const explicit = pairs.find(([k]) => k.toLowerCase() === 'content-type');
  for (const pair of authHeaderLines(request.auth)) pairs.push(pair);
  const mode = request.body?.mode;
  let autoContentType = null;
  if (!explicit && mode === 'json') autoContentType = 'application/json';
  if (!explicit && mode === 'form-urlencoded') autoContentType = 'application/x-www-form-urlencoded';
  if (autoContentType) pairs.push(['Content-Type', autoContentType]);
  return { pairs, contentType: explicit ? explicit[1] : autoContentType };
}

function withoutContentType(pairs) {
  return pairs.filter(([k]) => k.toLowerCase() !== 'content-type');
}

function formDataComments(request, marker = '//') {
  const lines = [
    `${marker} multipart/form-data body is not generated; add these fields with a multipart API:`,
  ];
  for (const f of formEntries(request)) {
    lines.push(
      isFileField(f)
        ? `${marker}   ${commentSafe(f.key)}: file ${commentSafe(filePlaceholder(f))}`
        : `${marker}   ${commentSafe(f.key)}: ${commentSafe(f.value ?? '')}`
    );
  }
  return lines;
}

const BODY_REQUIRED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'PROPPATCH', 'REPORT']);

function stringBody(request) {
  const body = request.body || { mode: 'none' };
  if (body.mode === 'json' || body.mode === 'raw') return body.raw || '';
  if (body.mode === 'form-urlencoded') return formUrlEncoded(request);
  return null;
}

// Language-specific string escaping. JSON.stringify output is valid for Go,
// Java and C# (all accept \" \\ \n and \uXXXX); PHP, Ruby, Swift and Kotlin
// need extra handling for interpolation and/or their own unicode escapes.
function goString(s) {
  return JSON.stringify(String(s));
}

function javaString(s) {
  return JSON.stringify(String(s));
}

function csString(s) {
  return JSON.stringify(String(s));
}

function phpString(s) {
  return (
    '"' +
    String(s)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      // eslint-disable-next-line no-control-regex -- control chars must be escaped in generated source
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`) +
    '"'
  );
}

function rubyString(s) {
  // Ruby double-quoted strings interpolate #{...}, #$var and #@ivar.
  return JSON.stringify(String(s)).replace(/#(?=[{$@])/g, () => '\\#');
}

function swiftString(s) {
  return (
    '"' +
    String(s)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      // eslint-disable-next-line no-control-regex -- control chars must be escaped in generated source
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, (c) => `\\u{${c.charCodeAt(0).toString(16)}}`) +
    '"'
  );
}

function kotlinString(s) {
  // Kotlin interpolates $name and ${...} in double-quoted strings.
  return JSON.stringify(String(s)).replace(/\$/g, () => '\\$');
}

// ---- JavaScript (axios) ----
export function toAxios(request) {
  const method = (request.method || 'GET').toUpperCase();
  const url = buildUrl(request);
  const info = collectHeaderInfo(request);
  const body = request.body || { mode: 'none' };

  const lines = ["const axios = require('axios');", '', 'async function main() {'];
  if (body.mode === 'form-data') {
    for (const line of formDataComments(request)) lines.push(`  ${line}`);
    lines.push('');
  }

  const options = [`    method: ${jsString(method)},`, `    url: ${jsString(url)},`];
  if (info.pairs.length) {
    options.push('    headers: {');
    for (const [k, v] of info.pairs) options.push(`      ${jsString(k)}: ${jsString(v)},`);
    options.push('    },');
  }
  if (body.mode === 'json' || body.mode === 'raw') {
    options.push(`    data: ${jsString(body.raw || '')},`);
  } else if (body.mode === 'form-urlencoded') {
    options.push('    data: new URLSearchParams({');
    for (const f of formEntries(request)) {
      if (!isFileField(f)) options.push(`      ${jsString(f.key)}: ${jsString(f.value ?? '')},`);
    }
    options.push('    }),');
  }

  lines.push('  const options = {', ...options, '  };', '');
  lines.push('  const response = await axios.request(options);');
  lines.push('  console.log(response.status, response.data);');
  lines.push('}', '', 'main();');
  return lines.join('\n');
}

// ---- Go (net/http) ----
export function toGo(request) {
  const method = (request.method || 'GET').toUpperCase();
  const url = buildUrl(request);
  const info = collectHeaderInfo(request);
  const body = request.body || { mode: 'none' };
  const encoded = stringBody(request);

  const imports = ['"fmt"', '"io"', '"net/http"'];
  if (encoded !== null) imports.push('"strings"');

  const lines = ['package main', '', 'import ('];
  for (const imp of imports) lines.push(`\t${imp}`);
  lines.push(')', '', 'func main() {', `\turl := ${goString(url)}`, '');

  if (body.mode === 'form-data') {
    for (const line of formDataComments(request)) lines.push(`\t${line}`);
    lines.push('\tvar body io.Reader');
  } else if (encoded !== null) {
    lines.push(`\tvar body io.Reader = strings.NewReader(${goString(encoded)})`);
  } else {
    lines.push('\tvar body io.Reader');
  }

  lines.push('', `\treq, err := http.NewRequest(${goString(method)}, url, body)`);
  lines.push('\tif err != nil {', '\t\tpanic(err)', '\t}', '');
  for (const [k, v] of info.pairs) lines.push(`\treq.Header.Set(${goString(k)}, ${goString(v)})`);
  if (info.pairs.length) lines.push('');
  lines.push('\tres, err := http.DefaultClient.Do(req)');
  lines.push('\tif err != nil {', '\t\tpanic(err)', '\t}', '\tdefer res.Body.Close()', '');
  lines.push('\tresBody, err := io.ReadAll(res.Body)');
  lines.push('\tif err != nil {', '\t\tpanic(err)', '\t}', '');
  lines.push('\tfmt.Println(res.Status)', '\tfmt.Println(string(resBody))', '}');
  return lines.join('\n');
}

// ---- Java (OkHttp 4) ----
export function toJava(request) {
  const method = (request.method || 'GET').toUpperCase();
  const url = buildUrl(request);
  const info = collectHeaderInfo(request);
  const body = request.body || { mode: 'none' };
  const needsEmptyBody = body.mode === 'form-data' && BODY_REQUIRED_METHODS.has(method);
  const hasBody =
    body.mode === 'json' ||
    body.mode === 'raw' ||
    body.mode === 'form-urlencoded' ||
    needsEmptyBody;

  const lines = [
    'import java.io.IOException;',
    'import okhttp3.FormBody;',
    'import okhttp3.MediaType;',
    'import okhttp3.OkHttpClient;',
    'import okhttp3.Request;',
    'import okhttp3.RequestBody;',
    'import okhttp3.Response;',
    '',
    'public class Main {',
    '  public static void main(String[] args) throws IOException {',
    '    OkHttpClient client = new OkHttpClient();',
    '',
  ];

  if (body.mode === 'form-data') {
    for (const line of formDataComments(request)) lines.push(`    ${line}`);
    lines.push('');
  }

  if (body.mode === 'json' || body.mode === 'raw') {
    const media = javaString(info.contentType || 'text/plain');
    lines.push(`    RequestBody body = RequestBody.create(MediaType.parse(${media}), ${javaString(body.raw || '')});`);
  } else if (body.mode === 'form-urlencoded') {
    lines.push('    RequestBody body = new FormBody.Builder()');
    for (const f of formEntries(request)) {
      if (!isFileField(f)) lines.push(`        .add(${javaString(f.key)}, ${javaString(f.value ?? '')})`);
    }
    lines.push('        .build();');
  } else if (needsEmptyBody) {
    lines.push('    RequestBody body = RequestBody.create(null, new byte[0]);');
  }
  if (hasBody) lines.push('');

  lines.push('    Request request = new Request.Builder()');
  lines.push(`        .url(${javaString(url)})`);
  lines.push(`        .method(${javaString(method)}, ${hasBody ? 'body' : 'null'})`);
  const headerPairs = hasBody ? withoutContentType(info.pairs) : info.pairs;
  for (const [k, v] of headerPairs) {
    lines.push(`        .addHeader(${javaString(k)}, ${javaString(v)})`);
  }
  lines.push('        .build();', '');
  lines.push('    try (Response response = client.newCall(request).execute()) {');
  lines.push('      System.out.println(response.code());');
  lines.push('      System.out.println(response.body().string());');
  lines.push('    }', '  }', '}');
  return lines.join('\n');
}

// ---- C# (HttpClient) ----
export function toCSharp(request) {
  const method = (request.method || 'GET').toUpperCase();
  const url = buildUrl(request);
  const info = collectHeaderInfo(request);
  const body = request.body || { mode: 'none' };
  const hasContent = body.mode === 'json' || body.mode === 'raw' || body.mode === 'form-urlencoded';

  const lines = [
    'using System;',
    'using System.Collections.Generic;',
    'using System.Net.Http;',
    'using System.Text;',
    'using System.Threading.Tasks;',
    '',
    'class Program',
    '{',
    '    static async Task Main()',
    '    {',
    '        using var client = new HttpClient();',
    '',
    `        var request = new HttpRequestMessage(new HttpMethod(${csString(method)}), ${csString(url)});`,
  ];
  const headerPairs = hasContent ? withoutContentType(info.pairs) : info.pairs;
  for (const [k, v] of headerPairs) {
    lines.push(`        request.Headers.TryAddWithoutValidation(${csString(k)}, ${csString(v)});`);
  }
  if (headerPairs.length) lines.push('');

  if (body.mode === 'form-data') {
    for (const line of formDataComments(request)) lines.push(`        ${line}`);
    lines.push('');
  } else if (body.mode === 'json' || body.mode === 'raw') {
    lines.push(
      `        request.Content = new StringContent(${csString(body.raw || '')}, Encoding.UTF8, ${csString(info.contentType || 'text/plain')});`
    );
    lines.push('');
  } else if (body.mode === 'form-urlencoded') {
    lines.push('        request.Content = new FormUrlEncodedContent(new[]');
    lines.push('        {');
    for (const f of formEntries(request)) {
      if (!isFileField(f)) {
        lines.push(
          `            new KeyValuePair<string, string>(${csString(f.key)}, ${csString(f.value ?? '')}),`
        );
      }
    }
    lines.push('        });', '');
  }

  lines.push('        var response = await client.SendAsync(request);');
  lines.push('        Console.WriteLine((int)response.StatusCode);');
  lines.push('        Console.WriteLine(await response.Content.ReadAsStringAsync());');
  lines.push('    }', '}');
  return lines.join('\n');
}

// ---- PHP (cURL) ----
export function toPhp(request) {
  const method = (request.method || 'GET').toUpperCase();
  const url = buildUrl(request);
  const info = collectHeaderInfo(request);
  const body = request.body || { mode: 'none' };
  const encoded = stringBody(request);

  const lines = [
    '<?php',
    '',
    '$ch = curl_init();',
    '',
    `curl_setopt($ch, CURLOPT_URL, ${phpString(url)});`,
    'curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);',
    `curl_setopt($ch, CURLOPT_CUSTOMREQUEST, ${phpString(method)});`,
  ];
  if (info.pairs.length) {
    lines.push('curl_setopt($ch, CURLOPT_HTTPHEADER, [');
    for (const [k, v] of info.pairs) lines.push(`    ${phpString(`${k}: ${v}`)},`);
    lines.push(']);');
  }
  if (body.mode === 'form-data') {
    for (const line of formDataComments(request)) lines.push(line);
  } else if (encoded !== null) {
    lines.push(`curl_setopt($ch, CURLOPT_POSTFIELDS, ${phpString(encoded)});`);
  }
  lines.push(
    '',
    '$response = curl_exec($ch);',
    '$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);',
    'curl_close($ch);',
    '',
    'echo $status . PHP_EOL;',
    'echo $response;'
  );
  return lines.join('\n');
}

// ---- Ruby (Net::HTTP) ----
const RUBY_HTTP_CLASSES = {
  GET: 'Get',
  POST: 'Post',
  PUT: 'Put',
  PATCH: 'Patch',
  DELETE: 'Delete',
  HEAD: 'Head',
  OPTIONS: 'Options',
  TRACE: 'Trace',
};

export function toRuby(request) {
  const method = (request.method || 'GET').toUpperCase();
  const url = buildUrl(request);
  const info = collectHeaderInfo(request);
  const body = request.body || { mode: 'none' };
  const encoded = stringBody(request);

  const lines = [
    "require 'net/http'",
    "require 'uri'",
    '',
    `uri = URI(${rubyString(url)})`,
    '',
    'http = Net::HTTP.new(uri.host, uri.port)',
    'http.use_ssl = uri.scheme == "https"',
    '',
  ];
  const rubyClass = RUBY_HTTP_CLASSES[method];
  lines.push(
    rubyClass
      ? `request = Net::HTTP::${rubyClass}.new(uri)`
      : `request = Net::HTTPGenericRequest.new(${rubyString(method)}, true, true, uri.request_uri)`
  );
  for (const [k, v] of info.pairs) lines.push(`request[${rubyString(k)}] = ${rubyString(v)}`);
  if (body.mode === 'form-data') {
    lines.push('');
    for (const line of formDataComments(request, '#')) lines.push(line);
  } else if (encoded !== null) {
    lines.push(`request.body = ${rubyString(encoded)}`);
  }
  lines.push(
    '',
    'response = http.request(request)',
    '',
    'puts response.code',
    'puts response.body'
  );
  return lines.join('\n');
}

// ---- Swift (URLSession, async/await) ----
export function toSwift(request) {
  const method = (request.method || 'GET').toUpperCase();
  const url = buildUrl(request);
  const info = collectHeaderInfo(request);
  const body = request.body || { mode: 'none' };
  const encoded = stringBody(request);

  const lines = [
    'import Foundation',
    '',
    `var request = URLRequest(url: URL(string: ${swiftString(url)})!)`,
    `request.httpMethod = ${swiftString(method)}`,
  ];
  for (const [k, v] of info.pairs) {
    lines.push(`request.setValue(${swiftString(v)}, forHTTPHeaderField: ${swiftString(k)})`);
  }
  if (body.mode === 'form-data') {
    for (const line of formDataComments(request)) lines.push(line);
  } else if (encoded !== null) {
    lines.push(`request.httpBody = ${swiftString(encoded)}.data(using: .utf8)`);
  }
  lines.push(
    '',
    'let (data, response) = try await URLSession.shared.data(for: request)',
    '',
    'if let http = response as? HTTPURLResponse {',
    '    print(http.statusCode)',
    '}',
    'print(String(data: data, encoding: .utf8) ?? "")'
  );
  return lines.join('\n');
}

// ---- Kotlin (OkHttp 4) ----
export function toKotlin(request) {
  const method = (request.method || 'GET').toUpperCase();
  const url = buildUrl(request);
  const info = collectHeaderInfo(request);
  const body = request.body || { mode: 'none' };
  const needsEmptyBody = body.mode === 'form-data' && BODY_REQUIRED_METHODS.has(method);
  const hasBody =
    body.mode === 'json' ||
    body.mode === 'raw' ||
    body.mode === 'form-urlencoded' ||
    needsEmptyBody;

  const lines = [
    'import okhttp3.FormBody',
    'import okhttp3.MediaType.Companion.toMediaType',
    'import okhttp3.OkHttpClient',
    'import okhttp3.Request',
    'import okhttp3.RequestBody',
    'import okhttp3.RequestBody.Companion.toRequestBody',
    '',
    'fun main() {',
    '    val client = OkHttpClient()',
    '',
  ];

  if (body.mode === 'form-data') {
    for (const line of formDataComments(request)) lines.push(`    ${line}`);
    lines.push('');
  }

  if (body.mode === 'json' || body.mode === 'raw') {
    lines.push(
      `    val body: RequestBody = ${kotlinString(body.raw || '')}.toRequestBody(${kotlinString(
        info.contentType || 'text/plain'
      )}.toMediaType())`
    );
  } else if (body.mode === 'form-urlencoded') {
    lines.push('    val body: RequestBody = FormBody.Builder()');
    for (const f of formEntries(request)) {
      if (!isFileField(f)) lines.push(`        .add(${kotlinString(f.key)}, ${kotlinString(f.value ?? '')})`);
    }
    lines.push('        .build()');
  } else if (needsEmptyBody) {
    lines.push('    val body: RequestBody = ByteArray(0).toRequestBody(null)');
  }
  if (hasBody) lines.push('');

  lines.push('    val request = Request.Builder()');
  lines.push(`        .url(${kotlinString(url)})`);
  lines.push(`        .method(${kotlinString(method)}, ${hasBody ? 'body' : 'null'})`);
  const headerPairs = hasBody ? withoutContentType(info.pairs) : info.pairs;
  for (const [k, v] of headerPairs) {
    lines.push(`        .addHeader(${kotlinString(k)}, ${kotlinString(v)})`);
  }
  lines.push(
    '        .build()',
    '',
    '    client.newCall(request).execute().use { response ->',
    '        println(response.code)',
    '        println(response.body?.string())',
    '    }',
    '}'
  );
  return lines.join('\n');
}

export const GENERATORS = {
  curl: { label: 'cURL', fn: toCurl },
  fetch: { label: 'JavaScript (fetch)', fn: toFetch },
  python: { label: 'Python (requests)', fn: toPython },
  httpie: { label: 'HTTPie', fn: toHttpie },
  axios: { label: 'JavaScript (axios)', fn: toAxios },
  go: { label: 'Go (net/http)', fn: toGo },
  java: { label: 'Java (OkHttp)', fn: toJava },
  csharp: { label: 'C# (HttpClient)', fn: toCSharp },
  php: { label: 'PHP (cURL)', fn: toPhp },
  ruby: { label: 'Ruby (Net::HTTP)', fn: toRuby },
  swift: { label: 'Swift (URLSession)', fn: toSwift },
  kotlin: { label: 'Kotlin (OkHttp)', fn: toKotlin },
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
