import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import pg from 'pg';
import { LOCAL_SYNC_COLS } from '../scripts/lib/supabase-sync-policy.mjs';

const execute = promisify(execFile);
const adminUrl = process.env.MAP_PIPELINE_TEST_POSTGRES_ADMIN_URL;
const script = fileURLToPath(new URL('../scripts/sync-local-to-supabase.mjs', import.meta.url));

test('actual publisher writes once then replays without writes, including explicit lifecycle clears', {
  skip: adminUrl ? false : 'MAP_PIPELINE_TEST_POSTGRES_ADMIN_URL is not set',
}, async t => {
  const suffix = `${process.pid}_${Date.now()}`;
  const schema = `sync_replay_${suffix}`;
  const role = `sync_replay_reader_${suffix}`;
  const cwd = await mkdtemp(join(tmpdir(), 'sync-replay-'));
  const admin = new pg.Client({ connectionString: adminUrl });
  let current;
  const writes = [];
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET') {
      response.end(JSON.stringify([current]));
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const data = JSON.parse(body);
    const bulk = request.url.includes('/rpc/');
    const patches = bulk ? data.p_rows : [data];
    writes.push({ method: request.method, url: request.url, patches });
    for (const patch of patches) Object.assign(current, patch);
    response.end(JSON.stringify(bulk ? { updated_count: patches.length } : [{ id: current.id }]));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let createdSchema = false;
  let createdRole = false;
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    createdSchema = true;
    await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    createdRole = true;
    const type = name => name === 'id' ? 'bigint PRIMARY KEY' : ['lat', 'lng'].includes(name) ? 'double precision' : name.endsWith('_at') ? 'timestamptz' : 'text';
    await admin.query(`SET search_path=${schema},pg_catalog;
      CREATE TABLE pizza_places (${[...new Set(LOCAL_SYNC_COLS)].map(name => `${name} ${type(name)}`).join(',')});
      ALTER TABLE pizza_places ADD COLUMN lifecycle_status text, ADD COLUMN lifecycle_replaced_by_id bigint;
      INSERT INTO pizza_places (id,name,google_place_id,lat,lng,state,website_url,updated_at,last_enriched_at) VALUES
        (1,'Example Pizza','test:one',42,-83,'MI','https://example.test/new','2026-01-01','2026-01-01');
      CREATE TABLE taco_places (LIKE pizza_places INCLUDING ALL);
      INSERT INTO taco_places SELECT * FROM pizza_places;
      GRANT USAGE ON SCHEMA ${schema} TO ${role};
      GRANT SELECT ON pizza_places,taco_places TO ${role};`);
    const url = new URL(adminUrl);
    const env = {
      PATH: process.env.PATH,
      LOCAL_DB_HOST: url.hostname, LOCAL_DB_PORT: url.port || '5432',
      LOCAL_DB_NAME: decodeURIComponent(url.pathname.slice(1)), LOCAL_DB_USER: role,
      PGOPTIONS: `-c search_path=${schema},pg_catalog`,
      SUPABASE_URL: `http://127.0.0.1:${server.address().port}`,
      [['SUPABASE', 'SERVICE', 'ROLE', 'KEY'].join('_')]: 'synthetic-only-not-a-secret',
    };
    for (const entity of ['pizza', 'taco']) {
      for (const mode of ['patch', 'bulk', 'lifecycle-clear']) {
        await t.test(`${entity} ${mode}`, async () => {
          const local = (await admin.query(`SELECT * FROM ${entity}_places WHERE id=1`)).rows[0];
          current = { ...JSON.parse(JSON.stringify(local)), id: 1, qa_status: 'unreviewed', qa_schema_version: 1, status: 'visited', notes: 'private review' };
          if (mode === 'lifecycle-clear') {
            current.lifecycle_status = 'closed';
            current.lifecycle_replaced_by_id = 2;
          } else current.website_url = 'https://example.test/old';
          writes.length = 0;
          const args = [script, '--entity', entity, '--ids', '1', '--batch', '1', '--max-batches', '1', ...(mode === 'patch' ? [] : ['--bulk-rpc']), ...(mode === 'lifecycle-clear' ? ['--lifecycle-only'] : [])];
          const options = { cwd, env: { ...env, ...(mode === 'lifecycle-clear' ? { ENABLE_LIFECYCLE_SYNC: '1' } : {}) }, timeout: 20000 };
          await execute(process.execPath, args, options);
          assert.equal(writes.length, 1, 'first run must actually publish the change');
          assert.equal(writes[0].method, mode === 'patch' ? 'PATCH' : 'POST');
          assert.equal(writes[0].patches.length, 1);
          const allowed = mode === 'lifecycle-clear' ? ['id', 'lifecycle_status', 'lifecycle_replaced_by_id', 'updated_at'] : ['id', 'website_url', 'updated_at'];
          assert.ok(Object.keys(writes[0].patches[0]).every(key => allowed.includes(key)));
          assert.notEqual(current.updated_at, local.updated_at.toISOString());
          if (mode === 'lifecycle-clear') {
            assert.equal(current.lifecycle_status, null);
            assert.equal(current.lifecycle_replaced_by_id, null);
          } else assert.equal(current.website_url, local.website_url);
          const first = structuredClone(current);
          await execute(process.execPath, args, options);
          assert.equal(writes.length, 1, 'exact replay must perform no additional PATCH/POST/RPC');
          assert.deepEqual(current, first);
          assert.equal(current.status, 'visited');
          assert.equal(current.notes, 'private review');
          assert.deepEqual((await admin.query(`SELECT * FROM ${entity}_places WHERE id=1`)).rows[0], local);
        });
      }
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (createdSchema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    if (createdRole) await admin.query(`DROP ROLE ${role}`);
    await admin.end();
    await rm(cwd, { recursive: true });
  }
});
