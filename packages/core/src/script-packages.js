// Shared catalogue of packages that user scripts may require.
//
// This module is imported by the renderer (for the Packages picker) and by the
// main-process script runner (to build the allow-list). It must stay free of
// Node imports so the renderer bundle never pulls in package implementations.
//
// Only pure-JavaScript packages belong here. Node built-ins (fs, path, crypto),
// network clients (axios, node-fetch) and packages that rely on Buffer/crypto
// host access are intentionally excluded.

export const SCRIPT_PACKAGES = Object.freeze([
  {
    id: 'crypto-js',
    name: 'crypto-js',
    requireName: 'crypto-js',
    description: 'Hashes, HMAC, and symmetric encryption.',
    example: [
      "const CryptoJS = require('crypto-js');",
      '',
      "const hash = CryptoJS.SHA256('hello').toString();",
      'console.log(hash);',
    ].join('\n'),
  },
  {
    id: 'moment',
    name: 'moment',
    requireName: 'moment',
    description: 'Parse, format, and manipulate dates.',
    example: [
      "const moment = require('moment');",
      '',
      "const formatted = moment('2026-01-01').format('YYYY-MM-DD');",
      'console.log(formatted);',
    ].join('\n'),
  },
  {
    id: 'uuid',
    name: 'uuid',
    requireName: 'uuid',
    description: 'Generate RFC 4122 UUIDs.',
    example: ["const uuid = require('uuid');", '', 'console.log(uuid.v4());'].join('\n'),
  },
  {
    id: 'lodash',
    name: 'lodash',
    requireName: 'lodash',
    description: 'Collection, object, and string utilities.',
    example: [
      "const _ = require('lodash');",
      '',
      'const chunks = _.chunk([1, 2, 3, 4], 2);',
      'console.log(chunks);',
    ].join('\n'),
  },
  {
    id: 'dayjs',
    name: 'dayjs',
    requireName: 'dayjs',
    description: 'Lightweight date parsing and formatting.',
    example: [
      "const dayjs = require('dayjs');",
      '',
      "const year = dayjs('2026-01-01').year();",
      'console.log(year);',
    ].join('\n'),
  },
  {
    id: 'ajv',
    name: 'ajv',
    requireName: 'ajv',
    description: 'Validate JSON data against a JSON Schema.',
    example: [
      "const Ajv = require('ajv');",
      '',
      'const ajv = new Ajv();',
      "const validate = ajv.compile({ type: 'object', required: ['id'] });",
      'console.log(validate({ id: 1 }));',
    ].join('\n'),
  },
  {
    id: 'fast-xml-parser',
    name: 'fast-xml-parser',
    requireName: 'fast-xml-parser',
    description: 'Convert XML text to a JavaScript object.',
    example: [
      "const { XMLParser } = require('fast-xml-parser');",
      '',
      'const parser = new XMLParser();',
      "const data = parser.parse('<user><id>1</id></user>');",
      'console.log(data);',
    ].join('\n'),
  },
  {
    id: 'qs',
    name: 'qs',
    requireName: 'qs',
    description: 'Parse and stringify query strings.',
    example: [
      "const qs = require('qs');",
      '',
      "const query = qs.stringify({ page: 1, tags: ['api', 'test'] });",
      'console.log(query);',
    ].join('\n'),
  },
]);

export const SCRIPT_PACKAGE_NAMES = Object.freeze(
  SCRIPT_PACKAGES.map((pkg) => pkg.requireName)
);

export function filterPackages(query) {
  const q = String(query || '')
    .trim()
    .toLowerCase();
  if (!q) return SCRIPT_PACKAGES;
  return SCRIPT_PACKAGES.filter((pkg) =>
    `${pkg.name} ${pkg.requireName} ${pkg.description}`.toLowerCase().includes(q)
  );
}
