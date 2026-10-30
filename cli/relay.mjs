#!/usr/bin/env node
// Relay CLI — run a Postman collection without the Electron app.
//
// The CLI reuses the renderer's runner engine (variable scopes, script hooks,
// data-driven iterations, retries) plus the Node request engine and script
// sandbox from `packages/core/src/`. No Electron APIs are touched here, so the command
// works in plain Node 22.
//
// Exit codes:
//   0  every request and test passed
//   1  at least one request or test failed (including `--bail` stops)
//   2  usage/input error (missing file, invalid JSON, unknown flag, report I/O)

import fs from 'node:fs';

import { fromPostmanCollection } from '../src/lib/postmanFormat.js';
import { fromPostmanEnvironment } from '../src/lib/environmentFormat.js';
import { varsToMap } from '../packages/core/src/variables.js';
import { runCollection } from '../src/lib/runner.js';
import { combinedPreRequest, combinedTests, effectiveAuth } from '../packages/core/src/inheritance.js';
import { toHtml, toJsonReport, toJUnit } from '../src/lib/report.js';
import { sendRequest } from '../packages/core/src/request-engine.js';
import { createSendContext } from '../packages/core/src/network-runtime.js';
import { runScript } from '../packages/core/src/script-runner.js';
import { normalizeNetworkSettings } from '../shared/networkSettings.js';
import { parseArgs, intOption, UsageError, USAGE } from './lib/args.mjs';
import { parseCsv } from './lib/csv.mjs';

const REPORT_FORMATS = new Map([
  ['json', 'json'],
  ['junit', 'xml'],
  ['html', 'html'],
]);

// One app-level network policy for the whole run. There are no CLI flags for
// proxies/TLS yet, but per-request `settings` imported from the collection
// (timeout, redirects, verifyTls) are still honored by createSendContext.
const network = normalizeNetworkSettings({});

function readText(file, label) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new UsageError(`Cannot read ${label} "${file}": ${err.message}`);
  }
}

function readJson(file, label) {
  const text = readText(file, label);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new UsageError(`Invalid JSON in ${label} "${file}": ${err.message}`);
  }
}

function loadCollection(file) {
  const json = readJson(file, 'collection');
  if (!json || typeof json !== 'object' || !Array.isArray(json.item)) {
    throw new UsageError(`Not a Postman collection: "${file}"`);
  }
  const collection = fromPostmanCollection(json);
  // Running a collection from the CLI is an explicit trust decision by its
  // author; unlike a renderer import there is no UI prompt to wait for.
  collection.scriptsTrusted = true;
  return collection;
}

function loadEnvironment(file) {
  const json = readJson(file, 'environment');
  if (!json || typeof json !== 'object' || !Array.isArray(json.values)) {
    throw new UsageError(`Not a Postman environment: "${file}"`);
  }
  return fromPostmanEnvironment(json);
}

// Depth-first flattening that also resolves per-request folder inheritance
// (the runner applies one ancestor chain to every request, so folder scripts
// and auth are folded into each request clone here).
function flattenRequests(collection) {
  const out = [];
  const walk = (items, folders) => {
    for (const node of items || []) {
      if (!node) continue;
      if (node.type === 'folder') {
        walk(node.items, [...folders, node]);
        continue;
      }
      if (!String(node.url || '').trim()) continue;
      const folderPre = combinedPreRequest({}, folders);
      const folderTests = combinedTests({}, folders);
      out.push({
        ...node,
        preRequest: [folderPre, node.preRequest]
          .filter((script) => typeof script === 'string' && script.trim())
          .join('\n;\n'),
        tests: [folderTests, node.tests]
          .filter((script) => typeof script === 'string' && script.trim())
          .join('\n;\n'),
        auth: effectiveAuth(node, [collection, ...folders]),
      });
    }
  };
  walk(collection.items, []);
  return out;
}

// Node transport for both the runner and `pm.sendRequest`.
async function send(resolved) {
  let ctx;
  try {
    ctx = createSendContext({ network, request: resolved });
  } catch (err) {
    return { ok: false, error: err.message, timeMs: 0 };
  }
  try {
    return await sendRequest(resolved, ctx.options);
  } finally {
    ctx.cleanup();
  }
}

// Script executor injected into the runner in place of the renderer bridge.
function executeScript(payload) {
  return runScript({
    ...payload,
    trusted: true,
    send: (request) => send(request),
  });
}

function formatDuration(timeMs) {
  const value = Number(timeMs);
  return Number.isFinite(value) && value > 0 ? `${value}ms` : '0ms';
}

function printSummary({ collection, summary, reportFile, elapsedMs }) {
  console.log(`Collection: ${collection.name}`);
  console.log(`Iterations: ${summary.iterations}`);
  console.log(
    `Requests: ${summary.requestsOk} ok, ${summary.requestsFailed} failed, ${summary.requestsSkipped} skipped`
  );
  console.log(`Tests: ${summary.testsPassed} passed, ${summary.testsFailed} failed`);
  console.log(`Time: ${formatDuration(elapsedMs)}`);
  console.log(`Report: ${reportFile}`);
}

function printStep(step) {
  const outcome = step.skipped
    ? 'skipped'
    : step.ok && !(typeof step.status === 'number' && step.status >= 500)
      ? String(step.status ?? '')
      : 'FAILED';
  console.log(
    `  #${step.iteration} ${step.method} ${step.url} -> ${outcome} (${formatDuration(step.timeMs)})`
  );
  if (!step.ok && step.error) console.log(`    error: ${step.error}`);
  for (const test of step.tests || []) {
    if (test.passed === false) {
      console.log(`    test failed: ${test.name}${test.error ? ` — ${test.error}` : ''}`);
    }
  }
}

function buildReport(run, meta, format) {
  if (format === 'junit') return toJUnit(run, meta);
  if (format === 'html') return toHtml(run, meta);
  return `${JSON.stringify(toJsonReport(run, meta), null, 2)}\n`;
}

async function runCommand(argv) {
  const parsed = parseArgs(argv);

  if (parsed.options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!parsed.command) {
    throw new UsageError('Missing command; expected "run"');
  }
  if (parsed.command !== 'run') {
    throw new UsageError(`Unknown command "${parsed.command}"; only "run" is supported`);
  }
  if (parsed.positionals.length === 0) {
    throw new UsageError('Missing collection file');
  }
  if (parsed.positionals.length > 1) {
    throw new UsageError(`Unexpected argument: ${parsed.positionals[1]}`);
  }

  const reportFormat = parsed.options.report || 'json';
  if (!REPORT_FORMATS.has(reportFormat)) {
    throw new UsageError(`Unknown report format "${reportFormat}"; expected json, junit, or html`);
  }
  const iterations = intOption(parsed.options.iterations, 1, {
    min: 1,
    name: '--iterations',
  });
  const delayMs = intOption(parsed.options.delay, 0, { min: 0, name: '--delay' });

  const collectionFile = parsed.positionals[0];
  const collection = loadCollection(collectionFile);
  const environment = parsed.options.env ? loadEnvironment(parsed.options.env) : null;
  const data = parsed.options.data
    ? parseCsv(readText(parsed.options.data, 'data file'))
    : null;

  if (data && data.length === 0) {
    throw new UsageError(`No data rows found in "${parsed.options.data}"`);
  }

  const requests = flattenRequests(collection);
  if (requests.length === 0) {
    throw new UsageError(`Collection "${collectionFile}" has no requests`);
  }

  const startedAt = new Date().toISOString();
  const started = Date.now();
  const verbose = parsed.options.verbose === true;

  const run = await runCollection({
    requests,
    send,
    environment: environment ? varsToMap(environment) : {},
    collection: varsToMap(collection),
    globals: {},
    collectionChain: [collection],
    delayMs,
    data,
    iterations,
    stopOnError: parsed.options.bail === true,
    keepVariableValues: false,
    runScript: executeScript,
    onProgress: verbose ? (step) => printStep(step) : undefined,
  });

  const finishedAt = new Date().toISOString();
  const elapsedMs = Date.now() - started;
  const meta = { name: collection.name, startedAt, finishedAt };
  const ext = REPORT_FORMATS.get(reportFormat);
  const reportFile = parsed.options.out || `relay-report.${ext}`;

  try {
    fs.writeFileSync(reportFile, buildReport(run, meta, reportFormat));
  } catch (err) {
    throw new UsageError(`Cannot write report "${reportFile}": ${err.message}`);
  }

  printSummary({ collection, summary: run.summary, reportFile, elapsedMs });

  const failedServerErrors = run.results.some(
    (step) => !step.skipped && typeof step.status === 'number' && step.status >= 500
  );
  return run.summary.requestsFailed > 0 || run.summary.testsFailed > 0 || failedServerErrors
    ? 1
    : 0;
}

async function main() {
  try {
    return await runCommand(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`relay: ${err.message}`);
      console.error('Run "relay --help" for usage.');
      return 2;
    }
    console.error(`relay: ${err && err.message ? err.message : String(err)}`);
    return 2;
  }
}

// Prefer a natural exit (so Windows pipe writes flush). Idle keep-alive
// sockets can keep the loop alive, so a last-resort unref'd timer forces exit.
function finish(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 500).unref();
}

main().then(finish, (err) => {
  console.error(`relay: ${err && err.message ? err.message : String(err)}`);
  finish(2);
});
