import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  inspectQueueDatabase,
  migrateQueueEntityIdentity,
} from './queue-entity-identity-migration.mjs';

const JOBS = `
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_type TEXT NOT NULL,
    osm_id TEXT NOT NULL,
    place_type TEXT NOT NULL,
    priority INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending',
    worker_id TEXT,
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,
    last_error TEXT,
    data TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT,
    UNIQUE(job_type, osm_id)
  );
  CREATE INDEX idx_jobs_pending ON jobs(job_type, status, priority DESC, created_at) WHERE status = 'pending';
  CREATE INDEX idx_jobs_processing ON jobs(worker_id, status) WHERE status = 'processing';
  CREATE INDEX idx_jobs_osm_id ON jobs(osm_id);
  CREATE TABLE workers (
    worker_id TEXT PRIMARY KEY,
    agent_type TEXT NOT NULL,
    status TEXT DEFAULT 'idle',
    current_job_id INTEGER,
    jobs_completed INTEGER DEFAULT 0,
    jobs_failed INTEGER DEFAULT 0,
    last_heartbeat TEXT DEFAULT (datetime('now')),
    started_at TEXT DEFAULT (datetime('now')),
    config TEXT
  );
`;

function fixture(t, { active = false, drift = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'food-queue-migration-'));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = join(directory, 'queue.db');
  const backup = join(directory, 'queue-before.db');
  const db = new Database(database);
  db.pragma('journal_mode = WAL');
  db.exec(JOBS);
  if (drift) db.exec('ALTER TABLE jobs ADD COLUMN unreviewed TEXT');
  db.prepare(`
    INSERT INTO jobs
      (id, job_type, osm_id, place_type, priority, status, worker_id, attempts, max_attempts, last_error, data, created_at, started_at, completed_at)
    VALUES
      (7, 'classify', 'shared-id', 'pizza', 42, ?, ?, 2, 8, 'kept', '{"partial_reprocess_count":1}', '2026-01-01', '2026-01-02', NULL)
  `).run(active ? 'processing' : 'pending', active ? 'worker-1' : null);
  db.prepare("INSERT INTO jobs(id, job_type, osm_id, place_type) VALUES (100, 'scrape', 'deleted-id', 'pizza')").run();
  db.prepare('DELETE FROM jobs WHERE id = 100').run();
  if (active) db.prepare("INSERT INTO workers(worker_id, agent_type, status, current_job_id) VALUES ('worker-1', 'classify', 'working', 7)").run();
  db.close();
  return { database, backup };
}

function rows(path) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db.prepare('SELECT * FROM jobs ORDER BY id').all();
  } finally {
    db.close();
  }
}

test('offline migration preserves queue rows, retry state, indexes, sequence, and backup', async t => {
  const paths = fixture(t);
  const beforeRows = rows(paths.database);
  const result = await migrateQueueEntityIdentity({ databasePath: paths.database, backupPath: paths.backup });

  assert.equal(result.migrated, true);
  assert.equal(result.before.state, 'legacy_global');
  assert.equal(result.after.state, 'entity_scoped');
  assert.deepEqual(rows(paths.database), beforeRows);
  assert.deepEqual(rows(paths.backup), beforeRows);
  assert.equal(inspectQueueDatabase(paths.backup).state, 'legacy_global');
  assert.equal(statSync(paths.backup).mode & 0o077, 0);

  const db = new Database(paths.database);
  try {
    assert.deepEqual(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'jobs' AND sql IS NOT NULL ORDER BY name").all().map(row => row.name),
      ['idx_jobs_osm_id', 'idx_jobs_pending', 'idx_jobs_processing'],
    );
    db.prepare("INSERT INTO jobs(job_type, osm_id, place_type) VALUES ('classify', 'shared-id', 'taco')").run();
    assert.equal(db.prepare("SELECT id FROM jobs WHERE place_type = 'taco'").get().id, 101);
    assert.throws(
      () => db.prepare("INSERT INTO jobs(job_type, osm_id, place_type) VALUES ('classify', 'shared-id', 'taco')").run(),
      /UNIQUE constraint failed/,
    );
  } finally {
    db.close();
  }
});

test('migration refuses active work before creating a backup', async t => {
  const paths = fixture(t, { active: true });
  await assert.rejects(
    migrateQueueEntityIdentity({ databasePath: paths.database, backupPath: paths.backup }),
    /active jobs or workers/,
  );
  assert.equal(existsSync(paths.backup), false);
  assert.equal(inspectQueueDatabase(paths.database).state, 'legacy_global');
});

test('migration rolls back fully when final verification cannot commit', async t => {
  const paths = fixture(t);
  const beforeRows = rows(paths.database);
  await assert.rejects(
    migrateQueueEntityIdentity({
      databasePath: paths.database,
      backupPath: paths.backup,
      beforeCommit() { throw new Error('synthetic final failure'); },
    }),
    /synthetic final failure/,
  );
  assert.equal(inspectQueueDatabase(paths.database).state, 'legacy_global');
  assert.deepEqual(rows(paths.database), beforeRows);
  assert.deepEqual(rows(paths.backup), beforeRows);
});

test('migration refuses schema drift and is idempotent after success', async t => {
  const drifted = fixture(t, { drift: true });
  await assert.rejects(
    migrateQueueEntityIdentity({ databasePath: drifted.database, backupPath: drifted.backup }),
    /unknown schema/,
  );
  assert.equal(existsSync(drifted.backup), false);

  const paths = fixture(t);
  await migrateQueueEntityIdentity({ databasePath: paths.database, backupPath: paths.backup });
  const second = await migrateQueueEntityIdentity({ databasePath: paths.database, backupPath: paths.backup });
  assert.equal(second.migrated, false);
  assert.equal(second.backupCreated, false);
  assert.equal(second.after.state, 'entity_scoped');
});

test('migration refuses dependent foreign keys and triggers before backup', async t => {
  for (const dependentSql of [
    'CREATE TABLE job_notes(job_id INTEGER REFERENCES jobs(id))',
    "CREATE TRIGGER jobs_audit AFTER UPDATE ON jobs BEGIN SELECT 1; END",
  ]) {
    const paths = fixture(t);
    const db = new Database(paths.database);
    db.exec(dependentSql);
    db.close();
    await assert.rejects(
      migrateQueueEntityIdentity({ databasePath: paths.database, backupPath: paths.backup }),
      /Foreign key|triggers/,
    );
    assert.equal(existsSync(paths.backup), false);
    assert.equal(inspectQueueDatabase(paths.database).state, 'legacy_global');
  }
});
