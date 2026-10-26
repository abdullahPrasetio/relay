import { describe, expect, test } from 'vitest';
import {
  GENERATORS,
  generateCode,
  toCurl,
  toFetch,
  toPython,
  toHttpie,
} from '../../src/lib/codegen.js';

function request(overrides = {}) {
  return {
    method: 'GET',
    url: 'https://api.example.com/items',
    params: [],
    headers: [],
    body: { mode: 'none', raw: '', form: [] },
    auth: { type: 'none' },
    ...overrides,
  };
}

// Per-target surface the generated source must expose for the method.
const TARGETS = {
  axios: { GET: 'method: "GET"', POST: 'method: "POST"' },
  go: { GET: 'http.NewRequest("GET"', POST: 'http.NewRequest("POST"' },
  java: { GET: '.method("GET"', POST: '.method("POST"' },
  csharp: { GET: 'new HttpMethod("GET")', POST: 'new HttpMethod("POST")' },
  php: { GET: 'CURLOPT_CUSTOMREQUEST, "GET"', POST: 'CURLOPT_CUSTOMREQUEST, "POST"' },
  ruby: { GET: 'Net::HTTP::Get.new', POST: 'Net::HTTP::Post.new' },
  swift: { GET: 'httpMethod = "GET"', POST: 'httpMethod = "POST"' },
  kotlin: { GET: '.method("GET"', POST: '.method("POST"' },
};

const TARGET_IDS = Object.keys(TARGETS);

function expectNoLeaks(out) {
  expect(out).not.toContain('undefined');
  expect(out).not.toContain('[object Object]');
  expect(out).not.toContain('NaN');
}

// A form pair may be rendered as `key=value`, a JS/Java/Kotlin argument pair,
// or an object entry. All three are valid output shapes.
function expectFormPair(out, key, value) {
  const candidates = [
    `${key}=${value}`,
    `${key}=${encodeURIComponent(value)}`,
    `"${key}", "${value}"`,
    `"${key}": "${value}"`,
  ];
  expect(candidates.some((needle) => out.includes(needle))).toBe(true);
}

const getRequest = request({
  method: 'GET',
  url: 'https://api.example.com/items',
  params: [
    { key: 'q', value: 'hello', enabled: true },
    { key: 'page', value: '2', enabled: true },
  ],
  headers: [
    { key: 'X-Client', value: 'relay', enabled: true },
    { key: 'Accept', value: 'application/json', enabled: true },
  ],
});

const JSON_BODY = '{"name":"Ada","active":true}';
const jsonRequest = request({
  method: 'POST',
  url: 'https://api.example.com/users',
  headers: [{ key: 'Accept', value: 'application/json', enabled: true }],
  body: { mode: 'json', raw: JSON_BODY, form: [] },
});

const formRequest = request({
  method: 'POST',
  url: 'https://api.example.com/form',
  headers: [{ key: 'Accept', value: '*/*', enabled: true }],
  body: {
    mode: 'form-urlencoded',
    raw: '',
    form: [
      { key: 'a', value: '1', enabled: true },
      { key: 'b', value: 'two words', enabled: true },
      { key: 'disabled', value: 'nope', enabled: false },
    ],
  },
});

const multipartRequest = request({
  method: 'POST',
  url: 'https://api.example.com/upload',
  headers: [{ key: 'Accept', value: 'application/json', enabled: true }],
  body: {
    mode: 'form-data',
    raw: '',
    form: [
      { key: 'title', value: 'Hello', enabled: true },
      { key: 'avatar', type: 'file', filePath: '/tmp/avatar.png', fileName: 'avatar.png', enabled: true },
    ],
  },
});

describe.each(TARGET_IDS)('%s generator', (lang) => {
  test('GET with query params and headers', () => {
    const out = generateCode(lang, getRequest);
    expect(out).toContain(TARGETS[lang].GET);
    expect(out).toContain('https://api.example.com/items?q=hello&page=2');
    for (const [name, value] of [
      ['X-Client', 'relay'],
      ['Accept', 'application/json'],
    ]) {
      expect(out).toContain(name);
      expect(out).toContain(value);
    }
    expectNoLeaks(out);
  });

  test('POST with JSON body', () => {
    const out = generateCode(lang, jsonRequest);
    expect(out).toContain(TARGETS[lang].POST);
    expect(out).toContain('https://api.example.com/users');
    expect(out).toContain('Accept');
    expect(out).toContain('application/json');
    expect(out).toContain('Ada');
    expect(out).toContain('active');
    expectNoLeaks(out);
  });

  test('POST with form-urlencoded body', () => {
    const out = generateCode(lang, formRequest);
    expect(out).toContain(TARGETS[lang].POST);
    expect(out).toContain('https://api.example.com/form');
    expect(out).toContain('Accept');
    expectFormPair(out, 'a', '1');
    expectFormPair(out, 'b', 'two words');
    // Disabled rows must not be sent.
    expect(out).not.toContain('nope');
    expectNoLeaks(out);
  });

  test('POST with multipart fields and a file placeholder', () => {
    const out = generateCode(lang, multipartRequest);
    expect(out).toContain(TARGETS[lang].POST);
    expect(out).toContain('https://api.example.com/upload');
    expect(out.toLowerCase()).toContain('multipart/form-data');
    expect(out).toContain('title');
    expect(out).toContain('Hello');
    expect(out).toContain('avatar');
    expect(out).toContain('/tmp/avatar.png');
    expectNoLeaks(out);
  });
});

// ---- Escaping ----

function unescapedQuoteCount(line) {
  let count = 0;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== '"') continue;
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && line[j] === '\\'; j -= 1) backslashes += 1;
    if (backslashes % 2 === 0) count += 1;
  }
  return count;
}

function isCommentLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*') || trimmed.startsWith('*');
}

const TRICKY_RAW = 'line1\nline2 "quoted" $var \\ back';
const trickyRequest = request({
  method: 'POST',
  url: 'https://api.example.com/search?q=a&lang=en',
  headers: [{ key: 'X-Test', value: 'v', enabled: true }],
  body: { mode: 'raw', raw: TRICKY_RAW, form: [] },
});

describe.each(TARGET_IDS)('%s escaping', (lang) => {
  const out = generateCode(lang, trickyRequest);

  test('keeps literal newlines escaped inside the body literal', () => {
    const bodyLines = out.split('\n').filter((line) => line.includes('line1'));
    expect(bodyLines).toHaveLength(1);
    expect(bodyLines[0]).toContain('line2');
  });

  test('escapes quotes, backslashes and interpolation markers', () => {
    expect(out).toContain('\\"quoted\\"');
    expect(out).toContain('\\\\ back');
    if (lang === 'php' || lang === 'kotlin') {
      expect(out).toContain('\\$var');
    } else {
      expect(out).toContain('$var');
    }
  });

  test('keeps the URL intact and quote-balanced', () => {
    expect(out).toContain('q=a&lang=en');
    const unbalanced = out
      .split('\n')
      .filter((line) => !isCommentLine(line))
      .filter((line) => unescapedQuoteCount(line) % 2 !== 0);
    expect(unbalanced).toEqual([]);
  });
});

// ---- Registry ----

describe('registry', () => {
  const minimal = request({});

  test('exposes the eight new targets after the existing four', () => {
    expect(Object.keys(GENERATORS)).toEqual([
      'curl',
      'fetch',
      'python',
      'httpie',
      'axios',
      'go',
      'java',
      'csharp',
      'php',
      'ruby',
      'swift',
      'kotlin',
    ]);
  });

  test.each(Object.entries(GENERATORS))('%s has a label and produces output', (id, generator) => {
    expect(typeof generator.label).toBe('string');
    expect(generator.label.length).toBeGreaterThan(0);
    expect(typeof generator.fn).toBe('function');
    const out = generator.fn(minimal);
    expect(typeof out).toBe('string');
    expect(out.trim().length).toBeGreaterThan(0);
  });

  test('unknown languages fall back to curl', () => {
    expect(generateCode('nope', minimal)).toBe(toCurl(minimal));
  });
});

// ---- Existing targets must stay byte-identical ----

describe('existing targets are unchanged', () => {
  const guardRequest = request({
    method: 'POST',
    url: 'https://api.example.com/users?x=1',
    headers: [{ key: 'Accept', value: 'application/json', enabled: true }],
    auth: { type: 'bearer', bearer: { token: 'tok' } },
    body: { mode: 'json', raw: '{"a":1}', form: [] },
  });

  test('curl output', () => {
    const expected = [
      "curl --location --request POST 'https://api.example.com/users?x=1' \\",
      "  --header 'Accept: application/json' \\",
      "  --header 'Authorization: Bearer tok' \\",
      "  --header 'Content-Type: application/json' \\",
      `  --data-raw '{"a":1}'`,
    ].join('\n');
    expect(toCurl(guardRequest)).toBe(expected);
  });

  test('fetch output', () => {
    const expected = [
      'const res = await fetch("https://api.example.com/users?x=1", {',
      '  method: "POST",',
      '  headers: {',
      '    "Accept": "application/json",',
      '    "Authorization": "Bearer tok",',
      '    "Content-Type": "application/json"',
      '  },',
      '  body: "{\\"a\\":1}",',
      '});',
      'const data = await res.text();',
      'console.log(res.status, data);',
    ].join('\n');
    expect(toFetch(guardRequest)).toBe(expected);
  });

  test('python and httpie keep their shapes', () => {
    const py = toPython(guardRequest);
    expect(py).toContain('import requests');
    expect(py).toContain('payload = {"a":1}');
    expect(py).toContain('requests.post(');

    const httpie = toHttpie(guardRequest);
    expect(httpie.startsWith('echo ')).toBe(true);
    expect(httpie).toContain('| http POST');
  });
});
