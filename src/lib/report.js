// Run report serializers.
//
// Pure functions: they take the `runCollection` result plus metadata and
// return strings/objects. Variable masking is the caller's responsibility;
// nothing here adds or removes secrets.

export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stepsOf(run) {
  return Array.isArray(run?.results) ? run.results : [];
}

function seconds(timeMs) {
  const value = Number(timeMs);
  return ((Number.isFinite(value) && value > 0 ? value : 0) / 1000).toFixed(3);
}

function failureMessages(step) {
  const messages = [];
  if (step.error) messages.push(String(step.error));
  for (const test of step.tests || []) {
    if (test.passed === false) {
      messages.push(test.error ? `${test.name}: ${test.error}` : `${test.name || 'Assertion'} failed`);
    }
  }
  return messages;
}

// Stable, JSON-serializable report object.
export function toJsonReport(run, meta = {}) {
  return {
    name: meta.name || '',
    startedAt: meta.startedAt ?? null,
    finishedAt: meta.finishedAt ?? null,
    summary: { ...(run?.summary || {}) },
    steps: stepsOf(run).map((step) => ({
      ...step,
      tests: (step.tests || []).map((test) => ({ ...test })),
    })),
    variables: {
      environment: { ...(run?.scopes?.environment || {}) },
      collection: { ...(run?.scopes?.collection || {}) },
      globals: { ...(run?.scopes?.globals || {}) },
    },
  };
}

function testCaseXml(step, includeIteration) {
  const name = includeIteration ? `#${step.iteration ?? 1} ${step.name || ''}` : (step.name || '');
  const failures = failureMessages(step);
  const attrs = `name="${escapeXml(name)}" time="${seconds(step.timeMs)}"`;
  if (step.skipped) {
    return `      <testcase ${attrs}>\n        <skipped/>\n      </testcase>`;
  }
  if (failures.length === 0) return `      <testcase ${attrs}/>`;
  const body = failures
    .map((message) => `        <failure message="${escapeXml(message)}">${escapeXml(message)}</failure>`)
    .join('\n');
  return `      <testcase ${attrs}>\n${body}\n      </testcase>`;
}

function groupSteps(steps) {
  const iterationIds = [...new Set(steps.map((step) => step.iteration ?? 1))];
  // Multiple iterations -> one suite per iteration. A single iteration (or a
  // run without iteration data) -> one suite per request.
  const perIteration = iterationIds.length > 1;
  const groups = new Map();
  for (const step of steps) {
    const key = perIteration
      ? `iteration:${step.iteration ?? 1}`
      : `request:${step.requestId || step.name || step.index}`;
    if (!groups.has(key)) {
      groups.set(key, {
        name: perIteration
          ? `Iteration ${step.iteration ?? 1}`
          : (step.name || `Request ${step.index + 1}`),
        steps: [],
      });
    }
    groups.get(key).steps.push(step);
  }
  return { groups: [...groups.values()], perIteration };
}

// Valid JUnit XML with counts that match the emitted children.
export function toJUnit(run, meta = {}) {
  const steps = stepsOf(run);
  const { groups, perIteration } = groupSteps(steps);

  let totalTests = 0;
  let totalFailures = 0;
  let totalSkipped = 0;

  const suites = groups.map((group) => {
    const cases = group.steps.map((step) => testCaseXml(step, perIteration));
    const failures = group.steps.filter((step) => !step.skipped && failureMessages(step).length > 0).length;
    const skipped = group.steps.filter((step) => step.skipped).length;
    const time = group.steps.reduce((sum, step) => sum + (Number(step.timeMs) || 0), 0);
    totalTests += group.steps.length;
    totalFailures += failures;
    totalSkipped += skipped;
    return [
      `  <testsuite name="${escapeXml(group.name)}" tests="${group.steps.length}" failures="${failures}" skipped="${skipped}" time="${seconds(time)}">`,
      ...cases,
      '  </testsuite>',
    ].join('\n');
  });

  const totalTime = steps.reduce((sum, step) => sum + (Number(step.timeMs) || 0), 0);
  const root = `  <testsuites name="${escapeXml(meta.name || 'Relay run')}" tests="${totalTests}" failures="${totalFailures}" skipped="${totalSkipped}" time="${seconds(totalTime)}">`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    root,
    ...suites,
    '  </testsuites>',
    '',
  ].join('\n');
}

// Standalone HTML document: inline CSS, no scripts, escaped values.
export function toHtml(run, meta = {}) {
  const steps = stepsOf(run);
  const summary = run?.summary || {};
  const name = meta.name || 'Relay run';
  const rows = steps.map((step) => {
    const failures = step.skipped ? [] : failureMessages(step);
    const outcome = step.skipped ? 'skipped' : failures.length ? 'failed' : 'passed';
    const status = step.skipped
      ? '—'
      : step.ok
        ? String(step.status ?? '')
        : 'error';
    return `      <tr class="${outcome}">
        <td>${escapeHtml(step.iteration ?? 1)}</td>
        <td>${escapeHtml(step.name || '')}</td>
        <td>${escapeHtml(step.method || '')}</td>
        <td class="url">${escapeHtml(step.url || '')}</td>
        <td>${escapeHtml(status)}</td>
        <td>${escapeHtml(step.timeMs ?? 0)} ms</td>
        <td>${escapeHtml(step.testsPassed ?? 0)}/${escapeHtml((step.testsPassed ?? 0) + (step.testsFailed ?? 0))}</td>
        <td>${failures.length ? escapeHtml(failures.join('; ')) : ''}</td>
      </tr>`;
  }).join('\n');

  const notes = [];
  if (summary.aborted) notes.push(`Aborted at step ${summary.stoppedAtStep ?? '?'}`);
  if (summary.stoppedReason === 'error') notes.push('Stopped after the first failed step');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(name)} · Relay run</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 24px; color: #1f2328; background: #fff; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    .meta { color: #59636e; font-size: 12px; margin-bottom: 16px; }
    .summary { display: flex; gap: 18px; flex-wrap: wrap; margin-bottom: 16px; font-size: 13px; }
    .summary span { background: #f2f4f7; border-radius: 4px; padding: 5px 9px; }
    .note { color: #9a6700; font-size: 13px; margin-bottom: 12px; }
    table { border-collapse: collapse; width: 100%; font-size: 12px; }
    th, td { border: 1px solid #d8dee4; padding: 6px 8px; text-align: left; vertical-align: top; }
    th { background: #f6f8fa; }
    td.url { word-break: break-all; font-family: ui-monospace, monospace; }
    tr.failed td { background: #fff5f5; }
    tr.skipped td { color: #59636e; font-style: italic; }
    tr.passed td:first-child { border-left: 3px solid #1a7f37; }
    tr.failed td:first-child { border-left: 3px solid #cf222e; }
    tr.skipped td:first-child { border-left: 3px solid #9a6700; }
  </style>
</head>
<body>
  <h1>${escapeHtml(name)}</h1>
  <div class="meta">${escapeHtml(meta.startedAt || '')}${meta.startedAt && meta.finishedAt ? ' → ' : ''}${escapeHtml(meta.finishedAt || '')}</div>
  <div class="summary">
    <span>${escapeHtml(summary.requestsOk ?? 0)} ok</span>
    <span>${escapeHtml(summary.requestsFailed ?? 0)} failed</span>
    <span>${escapeHtml(summary.requestsSkipped ?? 0)} skipped</span>
    <span>Tests: ${escapeHtml(summary.testsPassed ?? 0)} passed, ${escapeHtml(summary.testsFailed ?? 0)} failed</span>
  </div>
  ${notes.length ? `<div class="note">${escapeHtml(notes.join(' · '))}</div>` : ''}
  <table>
    <thead>
      <tr><th>#</th><th>Name</th><th>Method</th><th>URL</th><th>Status</th><th>Time</th><th>Tests</th><th>Failure</th></tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
</body>
</html>`;
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '') || 'collection';
}

function datePart(value) {
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

export function suggestReportName(meta = {}, format = 'json') {
  const normalized = String(format || 'json').toLowerCase();
  const ext = normalized === 'junit' || normalized === 'xml'
    ? 'xml'
    : normalized === 'html'
      ? 'html'
      : 'json';
  const date = datePart(meta.finishedAt || meta.startedAt);
  return `relay-run-${slugify(meta.name)}-${date}.${ext}`;
}
