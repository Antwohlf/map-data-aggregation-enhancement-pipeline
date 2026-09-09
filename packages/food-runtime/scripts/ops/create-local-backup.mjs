#!/usr/bin/env node
/**
 * Create a local recovery bundle for the iMac pipeline.
 *
 * This intentionally backs up only local Postgres and the SQLite queue. It
 * never contacts Supabase and never prints environment values.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { hostname } from 'node:os';
import Database from 'better-sqlite3';
import { loadRuntimeEnvironment } from '../lib/runtime-environment.mjs';

const ROOT = process.cwd();
const PG_DUMP_CANDIDATES = [
  '/Applications/Postgres.app/Contents/Versions/latest/bin/pg_dump',
];

function defaultPgDumpBin() {
  return PG_DUMP_CANDIDATES.find(candidate => existsSync(candidate)) || 'pg_dump';
}

const runtimeEnvironment = loadRuntimeEnvironment({ root: ROOT });

function value(name, fallback = undefined) {
  return runtimeEnvironment[name] ?? fallback;
}

function parseArgs(argv) {
  const options = {
    outputDir: value('APIZZA_BACKUP_DIR', join(ROOT, 'backups')),
    retention: Number(value('APIZZA_BACKUP_RETENTION', '7')),
    skipPostgres: false,
    skipQueue: false,
    dryRun: false,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output-dir') options.outputDir = argv[++index];
    else if (arg === '--retention') options.retention = Number(argv[++index]);
    else if (arg === '--skip-postgres') options.skipPostgres = true;
    else if (arg === '--skip-queue') options.skipQueue = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help') {
      console.log(`Usage: node scripts/ops/create-local-backup.mjs [options]

Options:
  --output-dir <path>  Backup root (default: backups/)
  --retention <count>  Number of completed runs to keep (default: 7)
  --skip-postgres      Skip the local Postgres dump
  --skip-queue         Skip the SQLite queue snapshot
  --dry-run            Show the planned backup without writing files
  --json               Emit a machine-readable result
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!Number.isInteger(options.retention) || options.retention < 1) {
    throw new Error('--retention must be a positive integer');
  }
  if (options.skipPostgres && options.skipQueue) {
    throw new Error('at least one backup target must remain enabled');
  }
  return options;
}

function sha256(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

function fileRecord(path, label) {
  return statSync(path).size;
}

async function describeFile(path, label) {
  return {
    label,
    file: path,
    bytes: fileRecord(path, label),
    sha256: await sha256(path),
  };
}

function postgresConfig() {
  return {
    host: value('PGHOST', 'localhost'),
    port: value('PGPORT', '5432'),
    user: value('PGUSER', value('USER', 'postgres')),
    database: value('PGDATABASE', 'pizza_enrichment'),
    password: value('PGPASSWORD'),
    // launchd does not inherit the interactive shell PATH. Prefer the known
    // local client locations before falling back to an explicitly configured
    // PG_DUMP_BIN or a PATH-provided pg_dump.
    dumpBin: value('PG_DUMP_BIN', defaultPgDumpBin()),
  };
}

function queuePath() {
  return resolve(ROOT, value('QUEUE_DB_PATH', 'scripts/.job-queue.db'));
}

function planned(options, runDir) {
  const config = postgresConfig();
  return {
    runDir,
    postgres: options.skipPostgres ? null : {
      database: config.database,
      host: config.host,
      port: config.port,
      file: join(runDir, 'pizza_enrichment.dump'),
    },
    queue: options.skipQueue ? null : {
      source: queuePath(),
      file: join(runDir, 'job-queue.db'),
    },
  };
}

function writePostgresDump(path) {
  const config = postgresConfig();
  const args = [
    '--format=custom',
    '--no-owner',
    '--no-acl',
    '--file',
    path,
    '--host',
    config.host,
    '--port',
    String(config.port),
    '--username',
    config.user,
    '--dbname',
    config.database,
  ];
  const env = { ...process.env };
  if (config.password) env['PGPASSWORD'] = config.password;
  execFileSync(config.dumpBin, args, {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15 * 60 * 1000,
  });
}

async function writeQueueSnapshot(source, destination) {
  if (!existsSync(source)) throw new Error(`queue database not found: ${source}`);
  const database = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await database.backup(destination);
  } finally {
    database.close();
  }
}

function prune(outputDir, retention) {
  const runs = readdirSync(outputDir)
    .map(name => join(outputDir, name))
    .filter(path => statSync(path).isDirectory() && existsSync(join(path, 'manifest.json')))
    .sort()
    .reverse();
  for (const oldRun of runs.slice(retention)) rmSync(oldRun, { recursive: true, force: true });
  return runs.slice(0, retention).length;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const timestamp = new Date().toISOString();
  const runName = timestamp.replace(/[:.]/g, '-');
  const outputDir = resolve(options.outputDir);
  const runDir = join(outputDir, runName);
  const plan = planned(options, runDir);

  if (options.dryRun) {
    const result = { status: 'dry-run', ...plan, retention: options.retention };
    console.log(options.json ? JSON.stringify(result, null, 2) : `Backup would be written to ${runDir}`);
    if (!options.json) console.log(JSON.stringify(result, null, 2));
    return;
  }

  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const files = [];
  if (plan.postgres) {
    writePostgresDump(plan.postgres.file);
    files.push(await describeFile(plan.postgres.file, 'local-postgres'));
  }
  if (plan.queue) {
    await writeQueueSnapshot(plan.queue.source, plan.queue.file);
    files.push(await describeFile(plan.queue.file, 'sqlite-queue'));
  }

  const manifest = {
    schema_version: 1,
    generated_at: timestamp,
    host: process.env.HOSTNAME || process.env.COMPUTERNAME || hostname(),
    files,
    retention: options.retention,
  };
  writeFileSync(join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const retainedRuns = prune(outputDir, options.retention);
  const result = { status: 'ok', runDir, files, retainedRuns };
  console.log(options.json ? JSON.stringify(result, null, 2) : `Backup created: ${runDir}\nFiles: ${files.length}\nRetained runs: ${retainedRuns}`);
}

main().catch(error => {
  console.error(`Backup failed: ${error.message}`);
  process.exitCode = 1;
});
