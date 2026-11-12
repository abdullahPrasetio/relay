import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { runScript } from '../../packages/core/src/script-runner.js';
import {
  SCRIPT_PACKAGES,
  SCRIPT_PACKAGE_NAMES,
  filterPackages,
} from '../../packages/core/src/script-packages.js';
import {
  SCRIPT_SNIPPETS,
  SNIPPET_CATEGORIES,
  filterSnippets,
} from '../../src/lib/scriptSnippets.js';

const emptyContext = () => ({
  local: {},
  environment: {},
  collection: {},
  globals: {},
  iterationData: {},
});

describe('script snippets catalogue', () => {
  it('has unique ids, valid categories, and syntactically valid code', () => {
    const ids = new Set();
    for (const snippet of SCRIPT_SNIPPETS) {
      expect(ids.has(snippet.id), `duplicate snippet id: ${snippet.id}`).toBe(false);
      ids.add(snippet.id);
      expect(SNIPPET_CATEGORIES).toContain(snippet.category);
      expect(snippet.name.length).toBeGreaterThan(0);
      expect(snippet.code.trim().length).toBeGreaterThan(0);
      expect(() => new vm.Script(snippet.code)).not.toThrow();
    }
  });

  it('keeps response-only snippets out of the Pre-request picker', () => {
    const pre = filterSnippets('', 'pre');
    const tests = filterSnippets('', 'test');

    expect(pre.some((snippet) => snippet.id === 'status-code-200')).toBe(false);
    expect(pre.some((snippet) => snippet.id === 'xml-to-json')).toBe(false);
    expect(pre.some((snippet) => snippet.id === 'get-global-variable')).toBe(true);
    expect(tests.some((snippet) => snippet.id === 'status-code-200')).toBe(true);
    expect(tests.some((snippet) => snippet.id === 'send-http-request')).toBe(true);
  });

  it('searches snippets case-insensitively', () => {
    const hits = filterSnippets('GLOBAL VARIABLE', 'pre');
    expect(hits.map((snippet) => snippet.id)).toContain('get-global-variable');
    expect(hits.every((snippet) => /global variable/i.test(snippet.name))).toBe(true);
  });
});

describe('script packages catalogue', () => {
  it('has unique ids and matching require names', () => {
    const ids = new Set();
    for (const pkg of SCRIPT_PACKAGES) {
      expect(ids.has(pkg.id), `duplicate package id: ${pkg.id}`).toBe(false);
      ids.add(pkg.id);
      expect(pkg.requireName).toBe(pkg.id);
      expect(SCRIPT_PACKAGE_NAMES).toContain(pkg.requireName);
      expect(pkg.description.length).toBeGreaterThan(0);
      expect(pkg.example.trim().length).toBeGreaterThan(0);
    }
  });

  it('searches packages case-insensitively', () => {
    expect(filterPackages('XML').map((pkg) => pkg.id)).toEqual(['fast-xml-parser']);
    expect(filterPackages('')).toHaveLength(SCRIPT_PACKAGES.length);
  });

  it('executes every bundled package inside the sandbox', async () => {
    const out = await runScript({
      phase: 'pre',
      script: `
        const CryptoJS = require('crypto-js');
        const moment = require('moment');
        const uuid = require('uuid');
        const _ = require('lodash');
        const dayjs = require('dayjs');
        const Ajv = require('ajv');
        const { XMLParser } = require('fast-xml-parser');
        const qs = require('qs');

        pm.variables.set('hash', CryptoJS.SHA256('x').toString());
        pm.variables.set('year', String(moment('2020-01-01').year()));
        pm.variables.set('uuidLength', String(uuid.v4().length));
        pm.variables.set('chunks', JSON.stringify(_.chunk([1, 2, 3], 2)));
        pm.variables.set('dayYear', String(dayjs('2020-01-01').year()));
        const validate = new Ajv().compile({ type: 'object', required: ['a'] });
        pm.variables.set('ajv', String(validate({ a: 1 })));
        pm.variables.set('xml', JSON.stringify(new XMLParser().parse('<a>1</a>')));
        pm.variables.set('query', qs.stringify({ a: 1 }));
      `,
      context: emptyContext(),
    });

    expect(out.error).toBeNull();
    expect(out.context.local.hash).toHaveLength(64);
    expect(out.context.local.year).toBe('2020');
    expect(out.context.local.uuidLength).toBe('36');
    expect(out.context.local.chunks).toBe('[[1,2],[3]]');
    expect(out.context.local.dayYear).toBe('2020');
    expect(out.context.local.ajv).toBe('true');
    expect(out.context.local.xml).toBe('{"a":1}');
    expect(out.context.local.query).toBe('a=1');
  });

  it('rejects packages outside the allow-list', async () => {
    const out = await runScript({
      phase: 'pre',
      script: "require('fs');",
      context: emptyContext(),
    });
    expect(out.error).toContain("require('fs') is not available");
  });
});
