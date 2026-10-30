// Isolated execution of user pre-request/test scripts (ROADMAP Fase 3.1 v1).
//
// Security model: the user code runs in a fresh `vm` realm. That realm has no
// host (`process`, `Buffer`, `require`, `fetch`, ...) and code generation from
// strings is disabled, so `Function('return process')()` and
// `({}).constructor.constructor('return process')()` both throw an EvalError
// and the host process object is never reachable through ECMAScript intrinsics.
//
// Known limitation: the `globals` we hand in are still HOST-realm objects
// (`pm`, allow-listed modules, URL, ...). Their `.constructor` is the host
// Function, so a determined script could use them as a bridge. Closing that
// requires a separate OS process (`utilityProcess`), which is the next step;
// it needs packaging/Windows work that v1 does not have. Until then only
// trusted collections may run scripts (see `trusted` in script-runner).
//
// Other limits of this v1: the timeout only interrupts JavaScript running in
// the realm (a blocking host function such as a huge PBKDF2 is not preempted),
// the body is not async, so top-level `await` is a syntax error, and async work
// that settles after the budget is not observed.
//
// The realm's own intrinsics (JSON, Math, Date, Promise, ...) are used as-is;
// we deliberately do NOT inject host references for them, since that would
// create exactly the bridge described above.

import vm from 'node:vm';

export const MAX_LOG_ENTRIES = 1000;
export const MAX_LOG_BYTES = 64 * 1024;

// `require` handed to scripts: only the modules the caller passed in (in
// practice crypto-js, moment, uuid). Anything else fails with a stable message
// so scripts get a clear hint instead of a host-module escape.
export function createSandboxRequire(modules = {}) {
  const table = modules && typeof modules === 'object' ? modules : {};
  return function sandboxRequire(name) {
    if (Object.prototype.hasOwnProperty.call(table, name)) return table[name];
    throw new Error(`require('${name}') is not available in scripts`);
  };
}

function formatLogArg(value) {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol' || typeof value === 'function') return String(value);
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    // Circular structures and hostile proxies: never let logging throw.
    return String(value);
  }
}

// Captured console with a hard cap. Once full, one truncation notice is
// recorded so the UI can say output was dropped instead of silently stalling.
function createLogSink() {
  const logs = [];
  let bytes = 0;
  let full = false;

  const record = (level, args) => {
    if (full) return;
    const text = args.map(formatLogArg).join(' ');
    const size = Buffer.byteLength(text, 'utf8');
    // Reserve the last slot for the notice so the cap is never exceeded.
    if (logs.length >= MAX_LOG_ENTRIES - 1 || bytes + size > MAX_LOG_BYTES) {
      full = true;
      logs.push({
        level: 'warn',
        text: `Console output truncated: limit of ${MAX_LOG_ENTRIES} entries / ${MAX_LOG_BYTES} bytes reached`,
      });
      return;
    }
    bytes += size;
    logs.push({ level, text });
  };

  return { logs, record };
}

function describeError(err, budgetMs) {
  if (err && (err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' || /execution timed out/i.test(String(err.message)))) {
    return `Script timed out after ${budgetMs}ms`;
  }
  if (err && typeof err.message === 'string' && err.message) return err.message;
  return String(err);
}

/**
 * Run `code` in a fresh vm realm.
 *
 * @param {object} options
 * @param {string} options.code         User script body.
 * @param {number} [options.timeoutMs]  Budget for the synchronous run (default 5000).
 * @param {object} [options.globals]    Host objects exposed as bare identifiers
 *                                      (`pm`, `require`, ...). Never pass `process`.
 * @returns {{ ok: boolean, error: string|null, logs: Array<{level:string,text:string}>,
 *            cleanup: () => void }}
 *   `cleanup` clears timers scheduled by the script; callers that await async
 *   work should call it once they are done so a late `setTimeout` cannot fire
 *   after the run is reported.
 */
export function runInSandbox({ code, timeoutMs = 5000, globals = {} } = {}) {
  const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.round(timeoutMs) : 5000;
  const deadline = Date.now() + budget;
  const { logs, record } = createLogSink();

  const injected = globals && typeof globals === 'object' ? globals : {};
  const names = Object.keys(injected);
  for (const name of names) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
      throw new Error(`Invalid sandbox global name: ${name}`);
    }
  }

  // Timers are host timers clamped to whatever budget is left. They only get a
  // chance to run while the caller awaits async work (pm.sendRequest), which is
  // why cleanup is returned instead of running here.
  const timers = new Map(); // script-facing id -> host handle
  let nextTimerId = 1;

  const sandboxSetTimeout = (fn, delay = 0, ...args) => {
    const id = nextTimerId++;
    if (typeof fn !== 'function') return id;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return id; // budget spent: schedule nothing
    const wait = Math.min(Math.max(0, Number(delay) || 0), remaining);
    const handle = setTimeout(() => {
      timers.delete(id);
      try {
        fn(...args);
      } catch (err) {
        // A timer runs outside runInContext, so an uncaught throw would escape
        // into the host event loop and could crash the main process.
        record('error', [`Uncaught error in timer callback: ${err && err.message ? err.message : String(err)}`]);
      }
    }, wait);
    timers.set(id, handle);
    return id;
  };

  const sandboxClearTimeout = (id) => {
    const handle = timers.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      timers.delete(id);
    }
  };

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    for (const handle of timers.values()) clearTimeout(handle);
    timers.clear();
  };

  const sandboxConsole = {
    log: (...args) => record('log', args),
    info: (...args) => record('log', args),
    debug: (...args) => record('log', args),
    warn: (...args) => record('warn', args),
    error: (...args) => record('error', args),
  };

  const sandbox = {
    console: sandboxConsole,
    setTimeout: sandboxSetTimeout,
    clearTimeout: sandboxClearTimeout,
    // URL/TextEncoder/TextDecoder are not ECMAScript intrinsics, so a bare realm
    // does not have them. Scripts use them often; they are the only host
    // constructors we expose (see the limitation note above).
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    __relayGlobals: injected,
  };

  const context = vm.createContext(sandbox, {
    name: 'relay-script',
    codeGeneration: { strings: false, wasm: false },
  });

  // Wrapping the body in a function keeps host objects as arguments instead of
  // realm globals: implicit assignments by the script then stay inside the
  // sandbox and cannot shadow what the caller injected (e.g. `pm`).
  const body = String(code ?? '');
  const args = names.map((name) => `__relayGlobals[${JSON.stringify(name)}]`).join(', ');
  const program = names.length
    ? `(function (${names.join(', ')}) {\n${body}\n})(${args})`
    : `(function () {\n${body}\n})()`;

  try {
    vm.runInContext(program, context, {
      timeout: budget,
      filename: 'user-script.js',
      displayErrors: false,
    });
    return { ok: true, error: null, logs, cleanup };
  } catch (err) {
    // A failed script has no reason to keep timers alive.
    cleanup();
    return { ok: false, error: describeError(err, budget), logs, cleanup };
  }
}
