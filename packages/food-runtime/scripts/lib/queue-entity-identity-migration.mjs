import Database from 'better-sqlite3';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const LEGACY_IDENTITY = Object.freeze(['job_type', 'osm_id']);
const ENTITY_IDENTITY = Object.freeze(['job_type', 'place_type', 'osm_id']);
const MIGRATION_TABLE = 'jobs_entity_identity_v2';
const JOB_COLUMNS = Object.freeze([
  ['id', 'INTEGER', 0, null, 1],
  ['job_type', 'TEXT', 1, null, 0],
  ['osm_id', 'TEXT', 1, null, 0],
  ['place_type', 'TEXT', 1, null, 0],
  ['priority', 'INTEGER', 0, '0', 0],
  ['status', 'TEXT', 0, "'pending'", 0],
  ['worker_id', 'TEXT', 0, null, 0],
  ['attempts', 'INTEGER', 0, '0', 0],
  ['max_attempts', 'INTEGER', 0, '3', 0],
  ['last_error', 'TEXT', 0, null, 0],
  ['data', 'TEXT', 0, null, 0],
  ['created_at', 'TEXT', 0, "datetime('now')", 0],
  ['started_at', 'TEXT', 0, null, 0],
  ['completed_at', 'TEXT', 0, null, 0],
]);
const COLUMN_NAMES = JOB_COLUMNS.map(([name]) => name);

const ENTITY_SCOPED_JOBS_TABLE = `
  CREATE TABLE ${MIGRATION_TABLE} (
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
    UNIQUE(job_type, place_type, osm_id)
  )
`;

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function expectedColumns(db) {
  const actual = db.pragma('table_info(jobs)');
  const comparable = actual.map(column => [
    column.name,
    String(column.type || '').toUpperCase(),
    Number(column.notnull),
    column.dflt_value,
    Number(column.pk),
  ]);
  if (JSON.stringify(comparable) !== JSON.stringify(JOB_COLUMNS)) {
    throw new Error('Unsupported jobs table columns; refusing to rebuild an unknown schema');
  }
  return actual;
}

function uniqueIdentities(db) {
  return db.pragma('index_list(jobs)')
    .filter(index => Number(index.unique) === 1)
    .map(index => db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(index.name).map(row => row.name));
}

function identityState(identities) {
  if (identities.length === 1 && sameValues(identities[0], ENTITY_IDENTITY)) return 'entity_scoped';
  if (identities.length === 1 && sameValues(identities[0], LEGACY_IDENTITY)) return 'legacy_global';
  return 'unsupported';
}

function integrityResult(db) {
  return db.pragma('integrity_check').map(row => Object.values(row)[0]);
}

export function inspectQueueEntityIdentity(db) {
  expectedColumns(db);
  const identities = uniqueIdentities(db);
  const state = identityState(identities);
  const active = {
    processingJobs: Number(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'processing'").get().count),
    workingWorkers: Number(db.prepare("SELECT COUNT(*) AS count FROM workers WHERE status = 'working'").get().count),
  };
  return {
    state,
    identities,
    rows: Number(db.prepare('SELECT COUNT(*) AS count FROM jobs').get().count),
    sequence: Number(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'jobs'").get()?.seq || 0),
    active,
  };
}

function schemaObjects(db) {
  return db.prepare(`
    SELECT type, name, sql
    FROM sqlite_master
    WHERE tbl_name = 'jobs'
      AND type = 'index'
      AND sql IS NOT NULL
    ORDER BY type, name
  `).all();
}

function assertSafeSchemaObjects(objects) {
  for (const object of objects) {
    if (!/^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(String(object.sql || ''))) {
      throw new Error(`Unsupported jobs ${object.type} definition: ${object.name}`);
    }
  }
}

function assertNoDependentSchema(db) {
  const tableSql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get()?.sql || '');
  if (/\b(?:CHECK|REFERENCES|STRICT)\b|\bFOREIGN\s+KEY\b|\bWITHOUT\s+ROWID\b/i.test(tableSql)) {
    throw new Error('Unsupported jobs table constraints; refusing migration');
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'jobs' LIMIT 1").get()) {
    throw new Error('Jobs table triggers must be reviewed before migration');
  }
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  for (const table of tables) {
    const referencesJobs = db.prepare('SELECT 1 FROM pragma_foreign_key_list(?) WHERE "table" = ? LIMIT 1').get(table.name, 'jobs');
    if (referencesJobs) throw new Error(`Foreign key from ${table.name} references jobs; refusing migration`);
  }
}

function verifyBackup(path, expectedRows, expectedSequence) {
  const backup = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const inspection = inspectQueueEntityIdentity(backup);
    if (inspection.state !== 'legacy_global'
      || inspection.rows !== expectedRows
      || inspection.sequence !== expectedSequence
      || integrityResult(backup).some(value => value !== 'ok')) {
      throw new Error('Queue backup verification failed');
    }
  } finally {
    backup.close();
  }
}

function canonicalBackupPath(databasePath, backupPath) {
  if (!backupPath) throw new Error('An explicit queue backup destination is required');
  const destination = resolve(backupPath);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const canonical = join(realpathSync(dirname(destination)), basename(destination));
  if (canonical === realpathSync(databasePath)) throw new Error('Queue backup destination must differ from the database');
  return canonical;
}

export function inspectQueueDatabase(databasePath) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return inspectQueueEntityIdentity(db);
  } finally {
    db.close();
  }
}

export async function migrateQueueEntityIdentity({
  databasePath,
  backupPath,
  beforeCommit = () => {},
} = {}) {
  const database = realpathSync(resolve(databasePath));
  const initial = inspectQueueDatabase(database);
  if (initial.state === 'entity_scoped') {
    return { migrated: false, backupCreated: false, before: initial, after: initial };
  }
  if (initial.state !== 'legacy_global') {
    throw new Error('Unsupported jobs uniqueness; expected legacy or entity-scoped identity');
  }

  const backup = canonicalBackupPath(database, backupPath);
  if (existsSync(backup)) throw new Error('Queue backup destination already exists');

  const writerLock = `${database}.writer-lock`;
  let ownsWriterLock = false;
  let backupVerified = false;
  const db = new Database(database, { fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    try {
      mkdirSync(writerLock, { mode: 0o700 });
      ownsWriterLock = true;
      writeFileSync(join(writerLock, 'owner'), `${process.pid}\n`, { mode: 0o600 });
    } catch (error) {
      if (error?.code === 'EEXIST') throw new Error('Queue writer lock is held; stop all food runtime jobs before migration');
      throw error;
    }

    db.exec('BEGIN EXCLUSIVE');
    const before = inspectQueueEntityIdentity(db);
    if (before.state !== 'legacy_global') throw new Error('Queue identity changed before migration lock was acquired');
    if (db.pragma('journal_mode', { simple: true }) !== 'wal') {
      throw new Error('Queue must already use WAL mode before migration');
    }
    if (before.active.processingJobs !== 0 || before.active.workingWorkers !== 0) {
      throw new Error('Queue has active jobs or workers; stop and drain before migration');
    }
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(MIGRATION_TABLE)) {
      throw new Error(`Unexpected ${MIGRATION_TABLE} table; refusing migration`);
    }

    const objects = schemaObjects(db);
    assertSafeSchemaObjects(objects);
    assertNoDependentSchema(db);
    // Back up through a separate read-only handle. In the queue's required WAL
    // mode it sees the stable pre-migration snapshot while this connection
    // excludes every competing writer.
    const backupSource = new Database(database, { readonly: true, fileMustExist: true });
    try {
      await backupSource.backup(backup);
    } finally {
      backupSource.close();
    }
    chmodSync(backup, 0o600);
    verifyBackup(backup, before.rows, before.sequence);
    backupVerified = true;

    db.exec(ENTITY_SCOPED_JOBS_TABLE);
    db.exec(`
      INSERT INTO ${MIGRATION_TABLE} (${COLUMN_NAMES.join(', ')})
      SELECT ${COLUMN_NAMES.join(', ')} FROM jobs
    `);
    const copiedRows = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${MIGRATION_TABLE}`).get().count);
    if (copiedRows !== before.rows) throw new Error('Queue row-count verification failed during migration');

    db.exec('DROP TABLE jobs');
    db.exec(`ALTER TABLE ${MIGRATION_TABLE} RENAME TO jobs`);
    for (const object of objects) db.exec(object.sql);
    const sequenceUpdate = db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'jobs'").run(before.sequence);
    if (sequenceUpdate.changes !== 1) {
      db.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES ('jobs', ?)").run(before.sequence);
    }

    const after = inspectQueueEntityIdentity(db);
    if (after.state !== 'entity_scoped'
      || after.rows !== before.rows
      || after.sequence !== before.sequence
      || integrityResult(db).some(value => value !== 'ok')) {
      throw new Error('Queue verification failed after entity identity migration');
    }
    beforeCommit({ db, before, after });
    db.exec('COMMIT');
    return { migrated: true, backupCreated: true, backup, before, after };
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    if (!backupVerified) rmSync(backup, { force: true });
    throw error;
  } finally {
    db.close();
    if (ownsWriterLock) rmSync(writerLock, { recursive: true, force: true });
  }
}
