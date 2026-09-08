import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import test from 'node:test';

import {
  BOOST_PENDING_CLASSIFY_JOB,
  SELECT_EXISTING_CLASSIFY_JOBS,
} from './classification-queue-sql.mjs';

function queueDatabase() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY,
      job_type TEXT NOT NULL,
      osm_id TEXT NOT NULL,
      place_type TEXT NOT NULL,
      priority INTEGER NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL,
      data TEXT
    )
  `);
  return db;
}

test('existing classify jobs are isolated by entity for the same canonical id', t => {
  const db = queueDatabase();
  t.after(() => db.close());
  const insert = db.prepare(`
    INSERT INTO jobs
      (id, job_type, osm_id, place_type, priority, status, attempts, max_attempts, data)
    VALUES (?, 'classify', 'shared-id', ?, 10, ?, 1, 3, ?)
  `);
  insert.run(1, 'pizza', 'completed', '{"partial_reprocess_count":1}');

  assert.deepEqual(db.prepare(SELECT_EXISTING_CLASSIFY_JOBS).all('taco'), []);

  insert.run(2, 'taco', 'pending',  '{"state":"MI"}');
  assert.deepEqual(db.prepare(SELECT_EXISTING_CLASSIFY_JOBS).all('taco'), [{
    osm_id: 'shared-id',
    status: 'pending',
    data: '{"state":"MI"}',
    id: 2,
  }]);
});

test('priority boost touches only the pending job for the selected entity', t => {
  const db = queueDatabase();
  t.after(() => db.close());
  const insert = db.prepare(`
    INSERT INTO jobs
      (id, job_type, osm_id, place_type, priority, status, attempts, max_attempts, data)
    VALUES (?, ?, 'shared-id', ?, 10, ?, ?, ?, ?)
  `);
  insert.run(1, 'classify', 'pizza', 'pending', 2, 7, '{"owner":"pizza"}');
  insert.run(2, 'classify', 'taco', 'pending', 1, 5, '{"owner":"taco"}');
  insert.run(3, 'classify', 'taco', 'completed', 3, 9, '{"owner":"completed"}');
  insert.run(4, 'scrape', 'taco', 'pending', 4, 11, '{"owner":"scrape"}');

  const result = db.prepare(BOOST_PENDING_CLASSIFY_JOB).run(110, 'taco', 'shared-id', 110);
  assert.equal(result.changes, 1);
  assert.deepEqual(db.prepare('SELECT id, priority, status, attempts, max_attempts, data FROM jobs ORDER BY id').all(), [
    { id: 1, priority: 10, status: 'pending', attempts: 2, max_attempts: 7, data: '{"owner":"pizza"}' },
    { id: 2, priority: 110, status: 'pending', attempts: 1, max_attempts: 5, data: '{"owner":"taco"}' },
    { id: 3, priority: 10, status: 'completed', attempts: 3, max_attempts: 9, data: '{"owner":"completed"}' },
    { id: 4, priority: 10, status: 'pending', attempts: 4, max_attempts: 11, data: '{"owner":"scrape"}' },
  ]);
});
