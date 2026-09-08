#!/usr/bin/env node

import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  inspectQueueDatabase,
  migrateQueueEntityIdentity,
} from '../lib/queue-entity-identity-migration.mjs';

function parseArgs(argv) {
  const options = {
    database: process.env.QUEUE_DB_PATH || 'scripts/.job-queue.db',
    backup: null,
    execute: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--database') options.database = argv[++index];
    else if (arg === '--backup') options.backup = argv[++index];
    else if (arg === '--execute') options.execute = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.help && !options.backup) throw new Error('--backup is required');
  if (!options.help && (!options.database || !existsSync(resolve(options.database)))) {
    throw new Error('Queue database does not exist');
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/ops/migrate-queue-entity-identity.mjs --backup <new-file> [options]

Options:
  --database <path>  Queue DB (default QUEUE_DB_PATH or scripts/.job-queue.db)
  --backup <path>    Required new backup file; existing files are never replaced
  --execute          Back up and migrate after exclusive offline checks
  --json             Print JSON
  --help             Print help

Without --execute this command is read-only. Before execution, stop every food
runtime job and wait for processing jobs/workers to reach zero. The command
refuses active work, unknown schemas, held writer locks, and existing backups.
`);
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) return printHelp();
  const database = resolve(options.database);
  const before = inspectQueueDatabase(database);
  if (!options.execute) {
    const plan = { mode: 'plan', database, backup: resolve(options.backup), inspection: before };
    console.log(options.json ? JSON.stringify(plan) : `queue identity: ${before.state}; rows=${before.rows}; processing=${before.active.processingJobs}; working=${before.active.workingWorkers}`);
    return;
  }
  const result = await migrateQueueEntityIdentity({ databasePath: database, backupPath: options.backup });
  console.log(options.json ? JSON.stringify(result) : result.migrated
    ? `queue identity migrated; rows=${result.after.rows}; backup=${result.backup}`
    : `queue identity already entity-scoped; rows=${result.after.rows}`);
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isMain()) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
