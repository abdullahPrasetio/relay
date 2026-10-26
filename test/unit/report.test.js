import { describe, expect, it } from 'vitest';
import {
  toJsonReport,
  toJUnit,
  toHtml,
  suggestReportName,
  escapeXml,
} from '../../src/lib/report.js';

const step = (over = {}) => ({
  index: 0,
  iteration: 1,
  requestId: 'req_1',
  name: 'First',
  method: 'GET',
  url: 'http://example.test/one',
  ok: true,
  status: 200,
  error: null,
  skipped: false,
  attempts: 1,
  retried: false,
  timeMs: 125,
  tests: [],
  testsPassed: 0,
  testsFailed: 0,
  ...over,
});

const run = {
  results: [
    step(),
    step({
      index: 1,
      requestId: 'req_2',
      name: 'A & B <tag> "quoted"',
      status: 500,
      ok: false,
      error: 'boom & <bad>',
      timeMs: 250,
    }),
    step({
      index: 2,
      requestId: 'req_3',
      name: 'Skipped',
      status: null,
      skipped: true,
      timeMs: 0,
    }),
    step({
      index: 3,
      requestId: 'req_2',
      name: 'Assertion',
      tests: [
        { name: 'ok', passed: true },
        { name: 'fails <x>', passed: false, error: 'expected 1 & got 2' },
      ],
      testsPassed: 1,
      testsFailed: 1,
    }),
  ],
  scopes: {
    environment: { token: 'abc' },
    collection: { mode: 'test' },
    globals: {},
  },
  summary: {
    iterations: 1,
    total: 4,
    requestsOk: 2,
    requestsFailed: 1,
    requestsSkipped: 1,
    testsPassed: 1,
    testsFailed: 1,
    retriedRequests: 0,
    aborted: false,
    stoppedAtStep: null,
    stoppedReason: null,
  },
};

const meta = {
  name: 'My API',
  startedAt: '2026-10-27T10:00:00.000Z',
  finishedAt: '2026-10-27T10:00:02.000Z',
};

function attr(xml, name) {
  const match = new RegExp(`${name}="([^"]*)"`).exec(xml);
  return match ? match[1] : null;
}

describe('toJUnit', () => {
  const xml = toJUnit(run, meta);

  it('emits a well-formed root and matching counts', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<testsuites');

    const testcases = xml.match(/<testcase\b[^>]*>/g) || [];
    const suites = xml.match(/<testsuite\b[^>]*>/g) || [];
    expect(testcases).toHaveLength(4);
    expect(suites).toHaveLength(3); // one suite per request when there is one iteration

    const rootLine = xml.split('\n').find((line) => line.includes('<testsuites'));
    expect(attr(rootLine, 'tests')).toBe('4');
    expect(attr(rootLine, 'failures')).toBe('2');
    expect(attr(rootLine, 'skipped')).toBe('1');

    // Suite counts add up to the root counts and match their children.
    const suiteBlocks = xml.split('</testsuite>').slice(0, -1);
    expect(suiteBlocks).toHaveLength(3);
    let suiteTests = 0;
    let suiteFailures = 0;
    let suiteSkipped = 0;
    for (const block of suiteBlocks) {
      const open = block.match(/<testsuite\b[^>]*>/)[0];
      const cases = (block.match(/<testcase\b/g) || []).length;
      const failingCases = (block.match(/<testcase\b[^>]*>[\s\S]*?<\/testcase>/g) || [])
        .filter((testcase) => testcase.includes('<failure')).length;
      expect(Number(attr(open, 'tests'))).toBe(cases);
      expect(Number(attr(open, 'failures'))).toBe(failingCases);
      suiteTests += cases;
      suiteFailures += Number(attr(open, 'failures'));
      suiteSkipped += Number(attr(open, 'skipped'));
    }
    expect(suiteTests).toBe(4);
    expect(suiteFailures).toBe(2);
    expect(suiteSkipped).toBe(1);
  });

  it('marks failed steps and failed assertions with <failure>', () => {
    expect((xml.match(/<failure\b/g) || []).length).toBe(2);
    expect(xml).toContain('boom &amp; &lt;bad&gt;');
    expect(xml).toContain('fails &lt;x&gt;: expected 1 &amp; got 2');
  });

  it('marks skipped steps with <skipped/>', () => {
    expect(xml).toContain('<skipped/>');
  });

  it('escapes XML special characters in names and attributes', () => {
    expect(xml).toContain('A &amp; B &lt;tag&gt; &quot;quoted&quot;');
    expect(xml).not.toContain('<tag>');
  });

  it('creates one testsuite per iteration when multiple iterations ran', () => {
    const multi = {
      ...run,
      results: [
        step({ iteration: 1 }),
        step({ iteration: 2, requestId: 'req_1' }),
      ],
    };
    const multiXml = toJUnit(multi, meta);
    const suites = multiXml.match(/<testsuite\b[^>]*>/g) || [];
    expect(suites).toHaveLength(2);
    expect(multiXml).toContain('name="Iteration 1"');
    expect(multiXml).toContain('name="Iteration 2"');
  });

  it('escapes arbitrary values', () => {
    expect(escapeXml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&apos;');
  });
});

describe('toJsonReport', () => {
  it('returns a stable, serializable shape', () => {
    const report = toJsonReport(run, meta);

    expect(report.name).toBe('My API');
    expect(report.startedAt).toBe(meta.startedAt);
    expect(report.finishedAt).toBe(meta.finishedAt);
    expect(report.summary.requestsFailed).toBe(1);
    expect(report.steps).toHaveLength(4);
    expect(report.steps[1].error).toBe('boom & <bad>');
    expect(report.steps[3].tests[1].passed).toBe(false);
    expect(report.variables.environment).toEqual({ token: 'abc' });
    expect(report.variables.collection).toEqual({ mode: 'test' });
    expect(report.variables.globals).toEqual({});

    const roundTrip = JSON.parse(JSON.stringify(report));
    expect(roundTrip).toEqual(report);
  });

  it('does not mutate the runner result', () => {
    const before = JSON.stringify({ summary: run.summary, results: run.results, scopes: run.scopes });
    toJsonReport(run, meta);
    expect(JSON.stringify({ summary: run.summary, results: run.results, scopes: run.scopes })).toBe(before);
  });
});

describe('toHtml', () => {
  const html = toHtml(run, meta);

  it('is a standalone document with inline CSS and no scripts', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<style>');
    expect(html).toContain('</html>');
    expect(html).not.toContain('<script');
  });

  it('escapes all user-controlled text', () => {
    expect(html).toContain('A &amp; B &lt;tag&gt; &quot;quoted&quot;');
    expect(html).toContain('boom &amp; &lt;bad&gt;');
    expect(html).toContain('fails &lt;x&gt;: expected 1 &amp; got 2');
    expect(html).not.toContain('<tag>');
  });

  it('shows summary counters and special outcomes', () => {
    expect(html).toContain('2 ok');
    expect(html).toContain('1 failed');
    expect(html).toContain('1 skipped');
    expect(html).toContain('Tests: 1 passed, 1 failed');
  });

  it('surfaces abort information', () => {
    const aborted = {
      ...run,
      summary: { ...run.summary, aborted: true, stoppedAtStep: 2 },
    };
    expect(toHtml(aborted, meta)).toContain('Aborted at step 2');
  });
});

describe('suggestReportName', () => {
  it('uses the run name, date, and format extension', () => {
    expect(suggestReportName(meta, 'junit')).toBe('relay-run-my-api-2026-10-27.xml');
    expect(suggestReportName(meta, 'xml')).toBe('relay-run-my-api-2026-10-27.xml');
    expect(suggestReportName(meta, 'json')).toBe('relay-run-my-api-2026-10-27.json');
    expect(suggestReportName(meta, 'html')).toBe('relay-run-my-api-2026-10-27.html');
  });

  it('slugifies names and falls back safely', () => {
    expect(suggestReportName({ name: '  My API! v2 ', startedAt: '2026-10-27T00:00:00Z' }, 'json'))
      .toBe('relay-run-my-api-v2-2026-10-27.json');
    expect(suggestReportName({}, 'json')).toMatch(/^relay-run-collection-\d{4}-\d{2}-\d{2}\.json$/);
    expect(suggestReportName({ name: 'Run' }, 'nope')).toMatch(/^relay-run-run-\d{4}-\d{2}-\d{2}\.json$/);
  });
});
