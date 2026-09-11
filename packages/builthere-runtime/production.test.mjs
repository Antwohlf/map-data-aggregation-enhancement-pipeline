import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabasePool, verifyStorageGuard } from './production.mjs';

test('production refuses missing or disabled SQL storage guard before any pending replay', async () => {
  for (const rows of [[],[{installed:false}],[{installed:null}]]) {
    await assert.rejects(verifyStorageGuard({query:async sql=>{
      assert.match(sql,/tgenabled IN/); assert.match(sql,/tgtype=7/);
      return {rows};
    }}),{code:'BUILTHERE_STORAGE_GUARD_MISSING'});
  }
  await verifyStorageGuard({query:async()=>({rows:[{installed:true}]})});
});

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
