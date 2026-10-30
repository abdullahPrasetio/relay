#!/usr/bin/env node
// Relay core CLI — one stored request per process, JSON in / JSON out.
//
//   stdin:  { "workspace": {...}, "requestId": "req_...", "environmentId": "env_..."|null }
//   stdout: { "response": { "status", "headers", "body", "timeMs" } | null,
//             "testResults": [{ "name", "passed", "error"? }],
//             "error": string|null }
//
// Exit codes: 0 = executed (HTTP errors / failed assertions included in the
// payload), 1 = execution error, 2 = invalid input or unknown request/env.
// stderr only ever receives static messages: never workspace or env values.
//
// Build: npm run build:core -> dist-core/relay-core.mjs.

import { buildExecutableRequest, runStoredRequest } from './request.js';

const MAX_INPUT_BYTES = 64 * 1024 * 1024;

function fail(code, message) {
  process.stderr.write(`relay-core: ${message}\n`);
  return code;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let text = '';
    let bytes = 0;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_INPUT_BYTES) {
        reject(new Error('input too large'));
        process.stdin.destroy();
        return;
      }
      text += chunk;
    });
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', reject);
  });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return fail(2, 'invalid JSON on stdin');
  }
  if (!isPlainObject(payload) || !isPlainObject(payload.workspace) || typeof payload.requestId !== 'string') {
    return fail(2, 'expected { workspace, requestId, environmentId? }');
  }

  const environmentId = payload.environmentId == null ? null : String(payload.environmentId);

  // Resolve once up front so an unknown request/environment exits 2 instead of
  // being reported as an execution failure. No I/O happens in this step.
  try {
    buildExecutableRequest({
      workspace: payload.workspace,
      requestId: payload.requestId,
      environmentId,
    });
  } catch {
    return fail(2, 'request or environment not found in workspace');
  }

  let result;
  try {
    result = await runStoredRequest({
      workspace: payload.workspace,
      requestId: payload.requestId,
      environmentId,
    });
  } catch {
    // runStoredRequest reports failures in its result; this is a last resort.
    result = { response: null, testResults: [], error: 'Request execution failed' };
  }

  await new Promise((resolve) => {
    process.stdout.write(`${JSON.stringify(result)}\n`, resolve);
  });
  return result.error ? fail(1, 'request execution failed') : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
    // Idle sockets would otherwise hold the process open; stdout is already
    // flushed by the write callback above.
    setTimeout(() => process.exit(code), 1000).unref();
  },
  () => {
    process.exitCode = 2;
    process.stderr.write('relay-core: unexpected failure\n');
    setTimeout(() => process.exit(2), 1000).unref();
  }
);
