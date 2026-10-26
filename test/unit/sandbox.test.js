import { describe, expect, it } from 'vitest';
import cryptoJs from 'crypto-js';
import moment from 'moment';
import { v4 as uuidv4 } from 'uuid';
import {
  MAX_LOG_ENTRIES,
  createSandboxRequire,
  runInSandbox,
} from '../../electron/sandbox/index.js';

const HOST_PID = String(process.pid);

function textOf(result) {
  return result.logs.map((entry) => entry.text).join('\n');
}

// Evaluation helper: the probe records the string form of `expr` or the thrown
// error name, so a failing expression can never abort the sandbox run itself.
function probe(expr, globals) {
  return runInSandbox({
    code: `
      let value;
      try {
        value = String(${expr});
      } catch (err) {
        value = 'threw:' + (err && err.name ? err.name : 'Error');
      }
      console.log(value);
    `,
    timeoutMs: 1000,
    globals,
  });
}

function probedValue(expr, globals) {
  const result = probe(expr, globals);
  expect(result.ok).toBe(true);
  return result.logs[0].text;
}

describe('sandbox isolation', () => {
  it('exposes no host globals', () => {
    const expressions = [
      'typeof process',
      'this.process',
      'globalThis.process',
      'typeof Buffer',
      'typeof global',
      'typeof module',
      'typeof exports',
      'typeof require',
      'typeof setImmediate',
      'typeof fetch',
      'typeof WebSocket',
    ];
    for (const expr of expressions) {
      expect(probedValue(expr), expr).toBe('undefined');
    }
  });

  it('cannot reach the host process directly', () => {
    const attempts = [
      'process.pid',
      'process',
      'globalThis.process.pid',
      'this.process.pid',
      'Function("return process")()',
      'Function("return process")().pid',
      '({}).constructor.constructor("return process")()',
      '({}).constructor.constructor("return process")().pid',
      '[].constructor.constructor("return process")().pid',
      'require("fs")',
      'require("child_process")',
    ];
    for (const expr of attempts) {
      const result = probe(expr);
      expect(result.ok, expr).toBe(true);
      const value = result.logs[0].text;
      // Every path either throws inside the realm or yields undefined.
      expect(value, expr).toMatch(/^(threw:|undefined$)/);
      expect(value, expr).not.toContain(HOST_PID);
      expect(textOf(result), expr).not.toContain(HOST_PID);
    }
  });

  it('blocks code generation from strings', () => {
    expect(probedValue('Function("return process")()')).toBe('threw:EvalError');
    expect(probedValue('({}).constructor.constructor("return process")()')).toBe('threw:EvalError');
  });

  it('only exposes allow-listed modules through require', () => {
    const require = createSandboxRequire({ 'crypto-js': cryptoJs, moment, uuid: { v4: uuidv4 } });
    const result = runInSandbox({
      code: `
        console.log(require('crypto-js').MD5('relay').toString());
        console.log(require('moment')('2020-05-05').format('YYYY-MM-DD'));
        console.log(typeof require('uuid').v4);
      `,
      globals: { require },
      timeoutMs: 2000,
    });
    expect(result.ok).toBe(true);
    expect(result.logs.map((entry) => entry.text)).toEqual([
      cryptoJs.MD5('relay').toString(),
      '2020-05-05',
      'function',
    ]);
  });

  it('rejects every other module with the stable message', () => {
    const require = createSandboxRequire({ 'crypto-js': cryptoJs });
    for (const name of ['fs', 'child_process', 'node:fs', 'crypto', 'node:crypto', 'vm']) {
      const result = runInSandbox({ code: `require(${JSON.stringify(name)})`, globals: { require } });
      expect(result.ok).toBe(false);
      expect(result.error).toBe(`require('${name}') is not available in scripts`);
    }
  });

  it('keeps implicit globals inside the sandbox', () => {
    const result = runInSandbox({
      code: 'leaky = 42; console.log(String(globalThis.leaky));',
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(true);
    expect(result.logs[0].text).toBe('42');
    expect(globalThis.leaky).toBeUndefined();
  });
});

describe('sandbox runtime', () => {
  it('provides only the documented safe globals', () => {
    const result = runInSandbox({
      code: `
        console.log(JSON.stringify({ a: 1 }));
        console.log(String(Math.max(1, 2)));
        console.log(new Date(0).toISOString());
        console.log(typeof Promise.resolve(1).then);
        console.log(new URL('https://example.com/x?y=1').hostname);
        console.log(new URLSearchParams('a=1').get('a'));
        console.log(String(new TextEncoder().encode('hi').length));
        console.log(new TextDecoder().decode(new Uint8Array([104, 105])));
        const id = setTimeout(() => {}, 1000);
        clearTimeout(id);
        console.log('timers-ok');
      `,
      timeoutMs: 2000,
    });
    expect(result.ok).toBe(true);
    expect(result.logs.map((entry) => entry.text)).toEqual([
      '{"a":1}',
      '2',
      '1970-01-01T00:00:00.000Z',
      'function',
      'example.com',
      '1',
      '2',
      'hi',
      'timers-ok',
    ]);
  });

  it('kills a synchronous infinite loop within the budget', () => {
    const started = Date.now();
    const result = runInSandbox({ code: 'while (true) {}', timeoutMs: 150 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/i);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('caps captured logs and records truncation once', () => {
    const result = runInSandbox({
      code: 'for (let i = 0; i < 5000; i++) console.log("line", i)',
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(true);
    expect(result.logs.length).toBe(MAX_LOG_ENTRIES);
    expect(result.logs.filter((entry) => /truncated/i.test(entry.text))).toHaveLength(1);
    expect(result.logs[result.logs.length - 1].text).toMatch(/truncated/i);
  });

  it('caps captured log bytes', () => {
    const chunk = 'x'.repeat(4096);
    const result = runInSandbox({
      code: `for (let i = 0; i < 40; i++) console.log(${JSON.stringify(chunk)})`,
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(true);
    expect(result.logs.at(-1).text).toMatch(/truncated/i);
    expect(result.logs.length).toBeLessThan(20);
  });

  it('runs timers while the caller awaits and cleanup cancels them', async () => {
    const running = runInSandbox({
      code: 'setTimeout(() => console.log("late"), 20)',
      timeoutMs: 500,
    });
    expect(running.logs).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(running.logs.map((entry) => entry.text)).toEqual(['late']);
    running.cleanup();

    const cancelled = runInSandbox({
      code: 'setTimeout(() => console.log("never"), 20)',
      timeoutMs: 500,
    });
    cancelled.cleanup();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(cancelled.logs).toHaveLength(0);
  });

  it('records a throwing timer callback instead of crashing', async () => {
    const result = runInSandbox({
      code: 'setTimeout(() => { throw new Error("timer boom"); }, 10)',
      timeoutMs: 500,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    result.cleanup();
    expect(result.ok).toBe(true);
    expect(result.logs.at(-1).text).toMatch(/timer boom/);
  });

  it('reports a syntax error without throwing', () => {
    const result = runInSandbox({ code: 'this is not javascript', timeoutMs: 500 });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
