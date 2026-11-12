// Ready-to-insert script snippets for the Pre-request and Tests editors.
//
// Every snippet is plain text: inserting one only edits the Monaco model, it is
// never evaluated by the renderer. The `phase` field keeps response-only
// snippets out of the Pre-request picker.

export const SNIPPET_CATEGORIES = Object.freeze([
  'Workflows',
  'Variables',
  'Assertions',
  'Response body',
  'Cookies',
  'Utilities',
]);

export const SCRIPT_SNIPPETS = Object.freeze([
  // ----- Workflows ---------------------------------------------------------
  {
    id: 'send-http-request',
    category: 'Workflows',
    phase: 'both',
    name: 'Send an HTTP request',
    code: [
      'pm.sendRequest(',
      '  {',
      "    url: 'https://postman-echo.com/get?foo=bar',",
      "    method: 'GET',",
      "    header: { Accept: 'application/json' },",
      '  },',
      '  function (err, res) {',
      '    if (err) {',
      '      console.error(err);',
      '      return;',
      '    }',
      '    console.log(res.json());',
      '  }',
      ');',
    ].join('\n'),
  },
  {
    id: 'send-http-request-json',
    category: 'Workflows',
    phase: 'both',
    name: 'Send an HTTP request with a JSON body',
    code: [
      'pm.sendRequest(',
      '  {',
      "    url: 'https://postman-echo.com/post',",
      "    method: 'POST',",
      '    header: {',
      "      'Content-Type': 'application/json',",
      "      Accept: 'application/json',",
      '    },',
      '    body: {',
      "      mode: 'raw',",
      "      raw: JSON.stringify({ name: 'Relay', role: 'api-client' }),",
      '    },',
      '  },',
      '  function (err, res) {',
      '    if (err) {',
      '      console.error(err);',
      '      return;',
      '    }',
      '    console.log(res.json());',
      '  }',
      ');',
    ].join('\n'),
  },

  // ----- Variables ---------------------------------------------------------
  {
    id: 'get-global-variable',
    category: 'Variables',
    phase: 'both',
    name: 'Get a global variable',
    code: ["const value = pm.globals.get('variable_key');", 'console.log(value);'].join('\n'),
  },
  {
    id: 'get-collection-variable',
    category: 'Variables',
    phase: 'both',
    name: 'Get a collection variable',
    code: [
      "const value = pm.collectionVariables.get('variable_key');",
      'console.log(value);',
    ].join('\n'),
  },
  {
    id: 'get-environment-variable',
    category: 'Variables',
    phase: 'both',
    name: 'Get an environment variable',
    code: [
      "const value = pm.environment.get('variable_key');",
      'console.log(value);',
    ].join('\n'),
  },
  {
    id: 'get-variable',
    category: 'Variables',
    phase: 'both',
    name: 'Get a variable',
    code: ["const value = pm.variables.get('variable_key');", 'console.log(value);'].join('\n'),
  },
  {
    id: 'set-global-variable',
    category: 'Variables',
    phase: 'both',
    name: 'Set a global variable',
    code: ["pm.globals.set('variable_key', 'variable_value');"].join('\n'),
  },
  {
    id: 'set-collection-variable',
    category: 'Variables',
    phase: 'both',
    name: 'Set a collection variable',
    code: ["pm.collectionVariables.set('variable_key', 'variable_value');"].join('\n'),
  },
  {
    id: 'set-environment-variable',
    category: 'Variables',
    phase: 'both',
    name: 'Set an environment variable',
    code: ["pm.environment.set('variable_key', 'variable_value');"].join('\n'),
  },
  {
    id: 'set-variable',
    category: 'Variables',
    phase: 'both',
    name: 'Set a variable',
    code: ["pm.variables.set('variable_key', 'variable_value');"].join('\n'),
  },
  {
    id: 'clear-global-variable',
    category: 'Variables',
    phase: 'both',
    name: 'Clear a global variable',
    code: ["pm.globals.unset('variable_key');"].join('\n'),
  },
  {
    id: 'clear-collection-variable',
    category: 'Variables',
    phase: 'both',
    name: 'Clear a collection variable',
    code: ["pm.collectionVariables.unset('variable_key');"].join('\n'),
  },
  {
    id: 'clear-environment-variable',
    category: 'Variables',
    phase: 'both',
    name: 'Clear an environment variable',
    code: ["pm.environment.unset('variable_key');"].join('\n'),
  },
  {
    id: 'clear-local-variable',
    category: 'Variables',
    phase: 'both',
    name: 'Clear a local variable',
    code: ["pm.variables.unset('variable_key');"].join('\n'),
  },

  // ----- Assertions --------------------------------------------------------
  {
    id: 'status-code-200',
    category: 'Assertions',
    phase: 'test',
    name: 'Status code is 200',
    code: [
      "pm.test('Status code is 200', function () {",
      '  pm.response.to.have.status(200);',
      '});',
    ].join('\n'),
  },
  {
    id: 'status-successful-post',
    category: 'Assertions',
    phase: 'test',
    name: 'Status code: successful POST request',
    code: [
      "pm.test('Status code is 201', function () {",
      '  pm.response.to.have.status(201);',
      '});',
    ].join('\n'),
  },
  {
    id: 'status-code-name-contains',
    category: 'Assertions',
    phase: 'test',
    name: 'Status code: code name contains a string',
    code: [
      "pm.test('Status code name contains Created', function () {",
      '  pm.response.to.have.status(/Created/i);',
      '});',
    ].join('\n'),
  },
  {
    id: 'response-time-below-200',
    category: 'Assertions',
    phase: 'test',
    name: 'Response time is below 200 ms',
    code: [
      "pm.test('Response time is below 200 ms', function () {",
      '  pm.expect(pm.response.responseTime).to.be.below(200);',
      '});',
    ].join('\n'),
  },
  {
    id: 'response-header-exists',
    category: 'Assertions',
    phase: 'test',
    name: 'Response header exists',
    code: [
      "pm.test('Response has Content-Type header', function () {",
      "  pm.response.to.have.header('Content-Type');",
      '});',
    ].join('\n'),
  },
  {
    id: 'json-field-equals',
    category: 'Assertions',
    phase: 'test',
    name: 'JSON body field equals a value',
    code: [
      "pm.test('JSON field has the expected value', function () {",
      '  pm.expect(pm.response.json().name).to.eql(\'Relay\');',
      '});',
    ].join('\n'),
  },
  {
    id: 'body-contains-string',
    category: 'Assertions',
    phase: 'test',
    name: 'Response body contains a string',
    code: [
      "pm.test('Response body contains Relay', function () {",
      "  pm.expect(pm.response.text()).to.include('Relay');",
      '});',
    ].join('\n'),
  },

  // ----- Response body -----------------------------------------------------
  {
    id: 'parse-json-body',
    category: 'Response body',
    phase: 'test',
    name: 'Parse JSON body',
    code: ['const data = pm.response.json();', 'console.log(data);'].join('\n'),
  },
  {
    id: 'xml-to-json',
    category: 'Response body',
    phase: 'test',
    name: 'Convert XML body to a JSON object',
    code: [
      "const { XMLParser } = require('fast-xml-parser');",
      '',
      'const parser = new XMLParser();',
      'const data = parser.parse(pm.response.text());',
      'console.log(data);',
    ].join('\n'),
  },
  {
    id: 'validate-json-ajv',
    category: 'Response body',
    phase: 'test',
    name: 'Validate JSON data with Ajv',
    code: [
      "const Ajv = require('ajv');",
      '',
      'const ajv = new Ajv();',
      'const validate = ajv.compile({',
      "  type: 'object',",
      "  required: ['id'],",
      "  properties: { id: { type: 'number' } },",
      '});',
      '',
      "pm.test('JSON matches schema', function () {",
      '  pm.expect(validate(pm.response.json())).to.be.true;',
      '});',
    ].join('\n'),
  },

  // ----- Cookies -----------------------------------------------------------
  {
    id: 'get-cookie',
    category: 'Cookies',
    phase: 'test',
    name: 'Get a cookie',
    code: ["const cookie = pm.cookies.get('cookie_name');", 'console.log(cookie);'].join('\n'),
  },
  {
    id: 'list-cookies',
    category: 'Cookies',
    phase: 'test',
    name: 'List cookies',
    code: ['const cookies = pm.cookies.toObject();', 'console.log(cookies);'].join('\n'),
  },

  // ----- Utilities ---------------------------------------------------------
  {
    id: 'base64-encode',
    category: 'Utilities',
    phase: 'both',
    name: 'Base64 encode',
    code: ["const encoded = btoa('hello');", 'console.log(encoded);'].join('\n'),
  },
  {
    id: 'base64-decode',
    category: 'Utilities',
    phase: 'both',
    name: 'Base64 decode',
    code: ["const decoded = atob('aGVsbG8=');", 'console.log(decoded);'].join('\n'),
  },
  {
    id: 'current-timestamp',
    category: 'Utilities',
    phase: 'both',
    name: 'Current timestamp',
    code: ['const timestamp = Date.now();', 'console.log(timestamp);'].join('\n'),
  },
  {
    id: 'require-package',
    category: 'Utilities',
    phase: 'both',
    name: 'Require a package',
    code: [
      "const _ = require('lodash');",
      '',
      'console.log(_.chunk([1, 2, 3, 4], 2));',
    ].join('\n'),
  },
]);

function matchesPhase(snippet, phase) {
  if (phase !== 'pre' && phase !== 'test') return true;
  return snippet.phase === 'both' || snippet.phase === phase;
}

export function filterSnippets(query, phase = 'both') {
  const q = String(query || '')
    .trim()
    .toLowerCase();
  return SCRIPT_SNIPPETS.filter((snippet) => {
    if (!matchesPhase(snippet, phase)) return false;
    if (!q) return true;
    return `${snippet.name} ${snippet.category}`.toLowerCase().includes(q);
  });
}
