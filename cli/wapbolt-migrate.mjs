#!/usr/bin/env node
// Wapbolt Local -> Relay migration.
//
// Reads Wapbolt's local SQLite database (read-only) and writes one Relay
// workspace export folder per Wapbolt team. Import each folder from Relay via
// Workspace switcher -> Import workspace...
//
// Usage:
//   node cli/wapbolt-migrate.mjs [--db <wapbolt-local.db>] [--out <dir>]
//
// The output contains the credentials that were stored in Wapbolt (headers,
// auth, variables). It is written owner-only; delete it after importing.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { rowsToWorkspaces } from './lib/wapbolt.mjs';
import { slugify, workspaceToFiles } from '../src/lib/gitWorkspace.js';
import { toWorkspaceBackup } from '../src/lib/postmanFormat.js';
import { toPostmanEnvironment } from '../src/lib/environmentFormat.js';

const MAX_WORKSPACE_FILE_BYTES = 2 * 1024 * 1024;
const TABLES = [
  'teams',
  'collections',
  'folders',
  'requests',
  'request_examples',
  'environments',
  'sync_meta',
];

const USAGE = `Usage: node cli/wapbolt-migrate.mjs [options]

Options:
  --db <file>   Wapbolt local database (default: the installed app's path)
  --out <dir>   Output root (default: ./wapbolt-relay-export)
  -h, --help    Show this help
`;

function defaultDbPath() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(
      home,
      'Library',
      'Application Support',
      'wapbolt-desktop-local',
      'wapbolt-local.db'
    );
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'wapbolt-desktop-local', 'wapbolt-local.db');
  }
  const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(config, 'wapbolt-desktop-local', 'wapbolt-local.db');
}

function readRows(db, table) {
  try {
    return db.prepare(`SELECT * FROM ${table}`).all();
  } catch (err) {
    throw new Error(`Cannot read table "${table}": ${err.message}`);
  }
}

function writeFiles(root, files) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, content, { mode: 0o600 });
  }
}

// A Relay workspace import rejects any file above 2 MB. Collections that large
// are emitted as Postman files instead, which the normal Import button accepts
// (and which keep Wapbolt's field validations via the Relay backup extension).
function splitOversized(workspace, generatedAt) {
  const files = workspaceToFiles(workspace, { generatedAt });
  const manifest = JSON.parse(files['relay-workspace.json']);
  const oversizedCollections = [];
  const oversizedEnvironments = [];
  for (const entry of manifest.collections || []) {
    if (Buffer.byteLength(files[entry.file] || '') > MAX_WORKSPACE_FILE_BYTES) {
      oversizedCollections.push(entry);
    }
  }
  for (const entry of manifest.environments || []) {
    if (Buffer.byteLength(files[entry.file] || '') > MAX_WORKSPACE_FILE_BYTES) {
      oversizedEnvironments.push(entry);
    }
  }
  if (!oversizedCollections.length && !oversizedEnvironments.length) {
    return { files, manual: [], oversizedCollections, oversizedEnvironments };
  }

  const collectionIds = new Set(oversizedCollections.map((entry) => entry.id));
  const environmentIds = new Set(oversizedEnvironments.map((entry) => entry.id));
  const filtered = {
    ...workspace,
    collections: workspace.collections.filter((collection) => !collectionIds.has(collection.id)),
    environments: workspace.environments.filter((environment) => !environmentIds.has(environment.id)),
  };
  const manual = [];
  for (const collection of workspace.collections.filter((item) => collectionIds.has(item.id))) {
    const backup = toWorkspaceBackup({ collections: [collection] });
    manual.push({
      relative: path.join(
        'collections',
        `${slugify(collection.name)}-${collection.id}.postman_collection.json`
      ),
      content: `${JSON.stringify(backup.collections[0], null, 2)}\n`,
    });
  }
  for (const environment of workspace.environments.filter((item) => environmentIds.has(item.id))) {
    manual.push({
      relative: path.join(
        'environments',
        `${slugify(environment.name)}-${environment.id}.postman_environment.json`
      ),
      content: `${JSON.stringify(toPostmanEnvironment(environment), null, 2)}\n`,
    });
  }
  return {
    files: workspaceToFiles(filtered, { generatedAt }),
    manual,
    oversizedCollections,
    oversizedEnvironments,
  };
}

function writeWorkspace(outRoot, workspace, generatedAt) {
  const dirName = `${slugify(workspace.name)}-${workspace.id}`;
  const dir = path.join(outRoot, dirName);
  const split = splitOversized(workspace, generatedAt);
  writeFiles(dir, split.files);
  let manualDir = null;
  if (split.manual.length) {
    manualDir = `${dir}-manual`;
    writeFiles(manualDir, Object.fromEntries(split.manual.map((item) => [item.relative, item.content])));
  }
  return {
    dir,
    manualDir,
    files: Object.keys(split.files).length,
    oversizedCollections: split.oversizedCollections.length,
    oversizedEnvironments: split.oversizedEnvironments.length,
  };
}

function formatStats(stats) {
  const parts = [
    `${stats.collections} collection(s)`,
    `${stats.requests} request(s)`,
    `${stats.folders} folder(s)`,
    `${stats.examples} example(s)`,
    `${stats.environments} environment(s)`,
  ];
  return parts.join(', ');
}

function main() {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        db: { type: 'string' },
        out: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  if (parsed.values.help) {
    console.log(USAGE);
    return;
  }

  const dbPath = path.resolve(parsed.values.db || defaultDbPath());
  const outRoot = path.resolve(parsed.values.out || 'wapbolt-relay-export');
  if (!fs.existsSync(dbPath)) {
    console.error(`Wapbolt database not found: ${dbPath}`);
    process.exitCode = 1;
    return;
  }

  let rows;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      rows = Object.fromEntries(TABLES.map((table) => [table, readRows(db, table)]));
    } finally {
      db.close();
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  const { workspaces, warnings, stats } = rowsToWorkspaces(rows);
  if (!workspaces.length) {
    console.error('No Wapbolt collections or environments found for any team.');
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(outRoot, { recursive: true, mode: 0o700 });
  const generatedAt = new Date().toISOString();
  const written = [];
  const allWarnings = [...warnings];
  for (const entry of workspaces) {
    const result = writeWorkspace(outRoot, entry.workspace, generatedAt);
    written.push({ name: entry.workspace.name, stats: entry.stats, ...result });
    if (result.oversizedCollections || result.oversizedEnvironments) {
      allWarnings.push(
        `${entry.workspace.name}: ${result.oversizedCollections} collection(s) and ` +
          `${result.oversizedEnvironments} environment(s) exceed Relay's 2 MB workspace-import ` +
          `limit; import them from ${result.manualDir}.`
      );
    }
  }

  console.log(`Read: ${dbPath}`);
  console.log(`Total: ${formatStats(stats)}`);
  for (const item of written) {
    console.log(`  ${item.name}: ${formatStats(item.stats)} -> ${item.dir}`);
  }
  if (allWarnings.length) {
    console.log('\nWarnings:');
    for (const warning of allWarnings) console.log(`  - ${warning}`);
  }
  console.log(
    '\nImport each workspace folder in Relay: Workspace switcher -> Import workspace...'
  );
  if (written.some((item) => item.manualDir)) {
    console.log(
      'For each *-manual folder: activate the imported workspace, then use the sidebar ' +
        'Import button for its collections and the environment Import button for its environments.'
    );
  }
  console.log(
    'The export contains credentials from Wapbolt; it is owner-only and should be deleted after import.'
  );
}

try {
  main();
} catch (err) {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
}
