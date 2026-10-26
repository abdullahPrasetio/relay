// cURL -> internal request converter.
//
// Pure ESM: no DOM, no Node APIs. This is intentionally a focused parser for
// the flags Relay can represent, not a full cURL implementation. Unknown flags
// are skipped (with their value when they are known to take one) so pasted
// commands still import.

import { newRequest } from '../factory.js';

const HTTP_URL = /^https?:\/\//i;

// Flags that consume the next token. Long form is stored without the dashes.
const LONG_VALUE_FLAGS = new Set([
  'request',
  'url',
  'header',
  'data',
  'data-raw',
  'data-binary',
  'data-ascii',
  'data-urlencode',
  'json',
  'form',
  'form-string',
  'user',
  'cookie',
  'user-agent',
  'referer',
  'output',
  'write-out',
  'max-time',
  'connect-timeout',
  'proxy',
  'cacert',
  'cert',
  'key',
  'retry',
  'limit-rate',
  'upload-file',
  'resolve',
  'cookie-jar',
]);

const SHORT_VALUE_FLAGS = new Set(['X', 'H', 'd', 'F', 'u', 'b', 'A', 'e', 'o', 'w', 'm', 'x', 'T']);

// Collapse `\` + newline continuations into a single space.
function stripLineContinuations(text) {
  return String(text ?? '').replace(/\\\r?\n[ \t]*/g, ' ');
}

// Process the escapes allowed inside `$'...'` (ANSI-C quoting), minimally.
function readAnsiCQuoted(input, start) {
  let value = '';
  let i = start + 2; // skip the `$'`
  while (i < input.length) {
    const ch = input[i];
    if (ch === '\\') {
      const next = input[i + 1];
      if (next === 'n') value += '\n';
      else if (next === 't') value += '\t';
      else if (next === 'r') value += '\r';
      else if (next === '0') value += '\0';
      else if (next === '\\') value += '\\';
      else if (next === "'") value += "'";
      else if (next == null) value += '\\';
      else value += next;
      i += 2;
      continue;
    }
    if (ch === "'") return { value, end: i + 1 };
    value += ch;
    i += 1;
  }
  return { value, end: i };
}

function readSingleQuoted(input, start) {
  let value = '';
  let i = start + 1;
  while (i < input.length) {
    if (input[i] === "'") return { value, end: i + 1 };
    value += input[i];
    i += 1;
  }
  return { value, end: i };
}

function readDoubleQuoted(input, start) {
  let value = '';
  let i = start + 1;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '\\') {
      const next = input[i + 1];
      // In double quotes a backslash only escapes these four characters.
      if (next === '"' || next === '\\' || next === '$' || next === '`') {
        value += next;
        i += 2;
        continue;
      }
      if (next === '\n') {
        i += 2;
        continue;
      }
      value += ch;
      i += 1;
      continue;
    }
    if (ch === '"') return { value, end: i + 1 };
    value += ch;
    i += 1;
  }
  return { value, end: i };
}

function readBare(input, start) {
  let value = '';
  let i = start;
  while (i < input.length && !/\s/.test(input[i])) {
    const ch = input[i];
    if (ch === '\\' && input[i + 1] != null) {
      value += input[i + 1];
      i += 2;
      continue;
    }
    value += ch;
    i += 1;
  }
  return { value, end: i };
}

// Split a command line into words, honouring shell quoting.
function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    let read;
    if (ch === '$' && input[i + 1] === "'") read = readAnsiCQuoted(input, i);
    else if (ch === "'") read = readSingleQuoted(input, i);
    else if (ch === '"') read = readDoubleQuoted(input, i);
    else read = readBare(input, i);
    tokens.push(read.value);
    i = read.end;
  }
  return tokens;
}

function splitHeaderToken(token) {
  const idx = token.indexOf(':');
  if (idx === -1) return null;
  const key = token.slice(0, idx).trim();
  if (!key) return null;
  return { key, value: token.slice(idx + 1).trim() };
}

function splitPair(text) {
  const idx = text.indexOf('=');
  if (idx === -1) return { key: text, value: '' };
  return { key: text.slice(0, idx), value: text.slice(idx + 1) };
}

function safeDecode(text) {
  try {
    return decodeURIComponent(String(text).replace(/\+/g, ' '));
  } catch {
    return String(text);
  }
}

// `--data-urlencode`: encode the value half, leave the name half alone.
function encodeDataUrlencode(piece) {
  const idx = piece.indexOf('=');
  if (idx === -1) return encodeURIComponent(piece);
  const name = piece.slice(0, idx);
  const value = piece.slice(idx + 1);
  return `${name}=${encodeURIComponent(value)}`;
}

function parseFormValue(raw) {
  // `key=value;type=mime` -> { value, contentType }
  const parts = raw.split(';');
  const value = parts[0];
  let contentType = '';
  for (const part of parts.slice(1)) {
    const [k, ...rest] = part.split('=');
    if (k.trim().toLowerCase() === 'type' && rest.length) contentType = rest.join('=').trim();
  }
  return { value, contentType };
}

function basename(filePath) {
  const clean = String(filePath).split('?')[0];
  const idx = clean.lastIndexOf('/');
  return idx === -1 ? clean : clean.slice(idx + 1);
}

function buildParams(text) {
  return String(text)
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const { key, value } = splitPair(pair);
      return { key: safeDecode(key), value: safeDecode(value), enabled: true };
    });
}

function looksLikeJson(text) {
  const trimmed = String(text).trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === 'object';
  } catch {
    return false;
  }
}

/**
 * Convert a cURL command string into a single internal request.
 * Throws when no http(s) URL can be found.
 */
export function fromCurl(text) {
  const cleaned = stripLineContinuations(text).replace(/^\s*\$\s*/, '');
  const tokens = tokenize(cleaned);

  let start = 0;
  if (tokens.length && /^curl(?:\.exe)?$/i.test(tokens[0])) start = 1;

  let explicitMethod = '';
  let url = '';
  let head = false;
  let getMode = false;
  let username;
  let password;
  const headers = [];
  const cookies = [];
  const dataParts = []; // { value, urlencode }
  const forms = [];
  let jsonPayload = '';
  let sawJson = false;

  const takeValue = (index) => {
    const value = tokens[index + 1];
    if (value == null) throw new Error(`Missing value for cURL flag ${tokens[index]}`);
    return value;
  };

  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;

    // `--flag=value` form.
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = (eq === -1 ? token.slice(2) : token.slice(2, eq)).toLowerCase();
      const inline = eq === -1 ? null : token.slice(eq + 1);
      const arg = () => (inline != null ? inline : takeValue(i));

      if (name === 'head') { head = true; continue; }
      if (name === 'get') { getMode = true; continue; }
      if (name === 'compressed' || name === 'silent' || name === 'location' || name === 'insecure'
        || name === 'include' || name === 'fail' || name === 'verbose' || name === 'globoff') {
        continue;
      }
      if (!LONG_VALUE_FLAGS.has(name)) {
        // Unknown long flag: skip it (and its inline value if any).
        continue;
      }

      const value = arg();
      if (inline == null) i += 1;

      switch (name) {
        case 'request':
          explicitMethod = value.toUpperCase();
          break;
        case 'url':
          if (!url && HTTP_URL.test(value)) url = value;
          break;
        case 'header': {
          const header = splitHeaderToken(value);
          if (header) headers.push(header);
          break;
        }
        case 'data':
        case 'data-raw':
        case 'data-binary':
        case 'data-ascii':
          dataParts.push({ value, urlencode: false });
          break;
        case 'data-urlencode':
          dataParts.push({ value, urlencode: true });
          break;
        case 'json':
          jsonPayload = value;
          sawJson = true;
          break;
        case 'form':
        case 'form-string': {
          const pair = splitPair(value);
          const key = pair.key.trim();
          if (!key) break;
          if (name === 'form' && pair.value.startsWith('@')) {
            const { value: path, contentType } = parseFormValue(pair.value.slice(1));
            forms.push({
              key,
              type: 'file',
              filePath: path,
              fileName: basename(path),
              contentType,
              enabled: true,
            });
          } else {
            forms.push({ key, value: pair.value, enabled: true });
          }
          break;
        }
        case 'user': {
          const idx = value.indexOf(':');
          username = idx === -1 ? value : value.slice(0, idx);
          password = idx === -1 ? '' : value.slice(idx + 1);
          break;
        }
        case 'cookie':
          cookies.push(value);
          break;
        default:
          break;
      }
      continue;
    }

    if (token.startsWith('-') && token !== '-') {
      const short = token[1];
      if (short === 'I' && token.length === 2) { head = true; continue; }
      if (short === 'G' && token.length === 2) { getMode = true; continue; }
      if (short === 'L' && token.length === 2) continue;
      if (short === 'k' && token.length === 2) continue;
      if (short === 's' && token.length === 2) continue;

      if (SHORT_VALUE_FLAGS.has(short)) {
        // Attached form: `-XPOST`, `-H'Name: v'` already tokenized as `-HName: v`.
        const attached = token.length > 2 ? token.slice(2) : null;
        const value = attached != null ? attached : takeValue(i);
        if (attached == null) i += 1;
        switch (short) {
          case 'X':
            explicitMethod = value.toUpperCase();
            break;
          case 'H': {
            const header = splitHeaderToken(value);
            if (header) headers.push(header);
            break;
          }
          case 'd':
            dataParts.push({ value, urlencode: false });
            break;
          case 'F': {
            const pair = splitPair(value);
            const key = pair.key.trim();
            if (!key) break;
            if (pair.value.startsWith('@')) {
              const { value: path, contentType } = parseFormValue(pair.value.slice(1));
              forms.push({
                key,
                type: 'file',
                filePath: path,
                fileName: basename(path),
                contentType,
                enabled: true,
              });
            } else {
              forms.push({ key, value: pair.value, enabled: true });
            }
            break;
          }
          case 'u': {
            const idx = value.indexOf(':');
            username = idx === -1 ? value : value.slice(0, idx);
            password = idx === -1 ? '' : value.slice(idx + 1);
            break;
          }
          case 'b':
            cookies.push(value);
            break;
          default:
            break;
        }
        continue;
      }
      // Unknown / valueless short flag (including clusters like `-sS`).
      continue;
    }

    // First bare token that parses as an http(s) URL wins.
    if (!url && HTTP_URL.test(token)) {
      try {
        new URL(token);
        url = token;
      } catch {
        // not a usable URL; keep scanning
      }
    }
  }

  if (!url) throw new Error('No URL found in cURL command');

  let dataText = dataParts
    .map((part) => (part.urlencode ? encodeDataUrlencode(part.value) : part.value))
    .join('&');

  let params = [];
  if (getMode && dataText) {
    params = buildParams(dataText);
    dataText = '';
  }

  let method = explicitMethod || (head ? 'HEAD' : (dataText || sawJson || forms.length ? 'POST' : 'GET'));
  if (getMode && !explicitMethod && !head) method = 'GET';

  // Merge headers, keeping the order the user wrote, last value winning.
  const mergedHeaders = [];
  const headerIndex = new Map();
  const addHeader = (key, value) => {
    const lower = key.toLowerCase();
    if (headerIndex.has(lower)) {
      mergedHeaders[headerIndex.get(lower)].value = value;
      return;
    }
    headerIndex.set(lower, mergedHeaders.length);
    mergedHeaders.push({ key, value, enabled: true });
  };
  for (const header of headers) addHeader(header.key, header.value);
  if (cookies.length) addHeader('Cookie', cookies.join('; '));

  let body;
  if (forms.length) {
    body = { mode: 'form-data', raw: '', form: forms, graphql: { query: '', variables: '' } };
  } else if (sawJson) {
    body = { mode: 'json', raw: jsonPayload, form: [], graphql: { query: '', variables: '' } };
    // An explicit Content-Type wins; curl supplies application/json otherwise.
    if (!mergedHeaders.some((h) => h.key.toLowerCase() === 'content-type')) {
      addHeader('Content-Type', 'application/json');
    }
    if (!mergedHeaders.some((h) => h.key.toLowerCase() === 'accept')) {
      addHeader('Accept', 'application/json');
    }
  } else if (dataText) {
    const contentType = mergedHeaders.find((h) => h.key.toLowerCase() === 'content-type');
    const isJson = (contentType && /json/i.test(contentType.value)) || looksLikeJson(dataText);
    if (isJson) {
      body = { mode: 'json', raw: dataText, form: [], graphql: { query: '', variables: '' } };
    } else if (dataParts.some((p) => p.value.includes('='))) {
      body = {
        mode: 'form-urlencoded',
        raw: dataText,
        form: buildParams(dataText),
        graphql: { query: '', variables: '' },
      };
    } else {
      body = { mode: 'raw', raw: dataText, form: [], graphql: { query: '', variables: '' } };
    }
  }

  let pathname = '';
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }

  const auth = username != null
    ? { type: 'basic', basic: { username, password: password ?? '' } }
    : undefined;

  return newRequest({
    name: `${method} ${pathname || '/'}`,
    method,
    url,
    params,
    headers: mergedHeaders,
    ...(body ? { body } : {}),
    ...(auth ? { auth: { ...newRequest().auth, ...auth } } : {}),
  });
}
