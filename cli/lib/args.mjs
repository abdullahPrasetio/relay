// Tiny dependency-free argument parser for the `relay` CLI.
//
// Supported forms: `--flag value`, `--flag=value`, and boolean flags.
// Unknown flags are a usage error (exit code 2), never silently ignored.

export class UsageError extends Error {}

export const USAGE = `Usage:
  relay run <collection.json> [options]

Options:
  --env <env.json>        Postman environment file
  --data <data.csv>       CSV data file (one iteration per row)
  --iterations <N>        Iterations without a data file (default: 1)
  --delay <ms>            Delay between requests (default: 0)
  --report <fmt>          Report format: json, junit, html (default: json)
  --out <file>            Report path (default: relay-report.<ext>)
  --bail                  Stop after the first failed request/test
  --verbose               Print a line per executed request
  -h, --help              Show this help
`;

const VALUE_FLAGS = new Map([
  ['--env', 'env'],
  ['--data', 'data'],
  ['--iterations', 'iterations'],
  ['--delay', 'delay'],
  ['--report', 'report'],
  ['--out', 'out'],
]);

const BOOLEAN_FLAGS = new Map([
  ['--bail', 'bail'],
  ['--verbose', 'verbose'],
  ['--help', 'help'],
  ['-h', 'help'],
]);

/**
 * Parse argv (without node/script). Returns
 * { command, positionals, options }.
 * Throws UsageError for unknown flags or missing flag values.
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const args = [...argv];
  const positionals = [];
  const options = {};
  let command = null;

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--') {
      positionals.push(...args);
      break;
    }

    if (arg.startsWith('-') && arg !== '-') {
      const eq = arg.indexOf('=');
      const flag = eq >= 0 ? arg.slice(0, eq) : arg;
      const inlineValue = eq >= 0 ? arg.slice(eq + 1) : undefined;

      if (BOOLEAN_FLAGS.has(flag)) {
        if (inlineValue !== undefined) {
          throw new UsageError(`Option ${flag} does not take a value`);
        }
        options[BOOLEAN_FLAGS.get(flag)] = true;
        continue;
      }

      if (!VALUE_FLAGS.has(flag)) {
        throw new UsageError(`Unknown option: ${flag}`);
      }
      const value = inlineValue !== undefined ? inlineValue : args.shift();
      if (value === undefined || value === '') {
        throw new UsageError(`Option ${flag} requires a value`);
      }
      options[VALUE_FLAGS.get(flag)] = value;
      continue;
    }

    if (!command) command = arg;
    else positionals.push(arg);
  }

  return { command, positionals, options };
}

/** Integer option with a lower bound; throws UsageError when invalid. */
export function intOption(value, fallback, { min = 0, name = 'value' } = {}) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) {
    throw new UsageError(`Invalid ${name}: expected an integer >= ${min}`);
  }
  return n;
}
