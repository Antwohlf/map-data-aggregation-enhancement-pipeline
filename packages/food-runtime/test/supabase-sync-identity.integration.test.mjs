import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

test('actual publisher blocks a mixed-identity batch before HTTP writes or checkpoint advancement', {
  skip: adminUrl ? false : 'MAP_PIPELINE_TEST_POSTGRES_ADMIN_URL is not set',
}, async () => {
  const suffix = `${process.pid}_${Date.now()}`;
  const schema = `sync_identity_${suffix}`;
  const role = `sync_reader_${suffix}`;
  const cwd = await mkdtemp(join(tmpdir(), 'sync-identity-'));
  const checkpoint = join(cwd, 'checkpoint.json');
  const admin = new pg.Client({ connectionString: adminUrl });
  const requests = [];
  let conflict = true;
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    requests.push({ method: request.method, path: url.pathname, select: url.searchParams.get('select'), id: url.searchParams.get('id') });
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET') {
      response.end(JSON.stringify([
        { id: 1, name: 'Example Pizza', google_place_id: 'test:one', lat: 42, lng: -83, state: 'MI' },
        { id: 2, name: conflict ? 'Different Restaurant' : 'Second Pizza', google_place_id: conflict ? null : 'test:two', lat: conflict ? 41 : 42, lng: conflict ? 2 : -83, state: conflict ? 'CAT' : 'MI' },
      ]));
    } else {
      response.end(url.pathname.includes('/rpc/') ? '2' : '[{"id":1}]');
    }
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
    const types = name => name === 'id' ? 'bigint PRIMARY KEY' : ['lat', 'lng'].includes(name) ? 'double precision' : name.endsWith('_at') ? 'timestamptz' : 'text';
    await admin.query(`SET search_path=${schema},pg_catalog;
      CREATE TABLE pizza_places (${[...new Set(LOCAL_SYNC_COLS)].map(name => `${name} ${types(name)}`).join(',')});
      INSERT INTO pizza_places (id,name,google_place_id,lat,lng,state,website_url,last_enriched_at) VALUES
        (1,'Example Pizza','test:one',42,-83,'MI','https://example.test/one',NOW()),
        (2,'Second Pizza','test:two',42,-83,'MI','https://example.test/two',NOW());
      ALTER TABLE pizza_places ADD COLUMN lifecycle_status text DEFAULT 'active', ADD COLUMN lifecycle_replaced_by_id bigint;
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
    const args = [script, '--entity', 'pizza', '--batch', '2', '--max-batches', '1', '--checkpoint', checkpoint];
    for (const variant of [[], ['--bulk-rpc'], ['--dry-run'], ['--entity', 'taco']]) {
      requests.length = 0;
      await assert.rejects(execute(process.execPath, [...args, ...variant], { cwd, env, timeout: 20000 }), /identity check failed/);
      assert.ok(requests.length > 0);
      assert.ok(requests.every(row => row.method === 'GET'), 'No PATCH/POST/RPC may run for either record');
      for (const column of ['id', 'name', 'lat', 'lng', 'state', 'google_place_id']) {
        assert.ok(requests[0].select.split(',').map(value => value.trim()).includes(column));
      }
      await assert.rejects(readFile(checkpoint), { code: 'ENOENT' });
    }
    requests.length = 0;
    await assert.rejects(execute(process.execPath, [script, '--entity', 'taco', '--ids', '1,2', '--lifecycle-only'], {
      cwd, env: { ...env, ENABLE_LIFECYCLE_SYNC: '1' }, timeout: 20000,
    }), /identity check failed/);
    assert.ok(requests.length > 0 && requests.every(row => row.method === 'GET'));
    conflict = false;
    requests.length = 0;
    await execute(process.execPath, args, { cwd, env, timeout: 20000 });
    assert.equal(requests.filter(row => row.method === 'PATCH').length, 2);
    assert.deepEqual(requests.filter(row => row.method === 'PATCH').map(row => row.id).sort(), ['eq.1', 'eq.2']);
    assert.equal(JSON.parse(await readFile(checkpoint, 'utf8')).id, 2);
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (createdSchema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    if (createdRole) await admin.query(`DROP ROLE ${role}`);
    await admin.end();
    await rm(cwd, { recursive: true });
  }
});
