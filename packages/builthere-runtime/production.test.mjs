import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabasePool } from './production.mjs';

test('database pool is lazy, single-connection, and handles sanitized idle disconnects', async () => {
  const events=[];
  const pool=createDatabasePool('postgresql://example.test/synthetic',event=>events.push(event));
  try {
    assert.equal(pool.totalCount,0);
    assert.equal(pool.options.max,1);
    assert.equal(pool.options.idleTimeoutMillis,30000);
    pool.emit('error',Object.assign(new Error('private database detail'),{code:'57P01'}));
    pool.emit('error',Object.assign(new Error('private database detail'),{code:'invalid private value'}));
    assert.deepEqual(events,[{type:'idle_database_connection_closed',code:'57P01'},{type:'idle_database_connection_closed',code:'DATABASE_CONNECTION_CLOSED'}]);
    assert.equal(pool.totalCount,0);
  } finally {await pool.end();}
});
