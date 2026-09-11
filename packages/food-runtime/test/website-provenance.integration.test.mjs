import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import pg from 'pg';

const execute = promisify(execFile);
const adminUrl = process.env.MAP_PIPELINE_TEST_POSTGRES_ADMIN_URL;
const script = fileURLToPath(new URL('../scripts/ops/record-website-provenance.mjs', import.meta.url));

test('real PostgreSQL provenance CLI isolates products and IDs, replays safely, and preserves private fields', {
  skip: adminUrl ? false : 'MAP_PIPELINE_TEST_POSTGRES_ADMIN_URL is not set',
}, async () => {
  // Only this uniquely owned schema and role are created and removed.
  const suffix = `${process.pid}_${Date.now()}`;
  const schema = `provenance_test_${suffix}`;
  const role = `provenance_writer_${suffix}`;
  const password = ['synthetic', 'test', suffix].join('-');
  const cwd = await mkdtemp(join(tmpdir(), 'provenance-cli-'));
  const admin = new pg.Client({ connectionString: adminUrl });
  let createdSchema = false;
  let createdRole = false;
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    createdSchema = true;
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    createdRole = true;
    await admin.query(`
      SET search_path = ${schema}, pg_catalog;
      CREATE TABLE taco_places (
        id bigint PRIMARY KEY, website_url text, phone text, menu_url text,
        email text, hours jsonb, delivery text, takeaway text, scrape_method text,
        last_enriched_at timestamptz, updated_at timestamptz,
        personal_rating integer, notes text
      );
      CREATE TABLE pizza_places (LIKE taco_places INCLUDING ALL, menu_data jsonb);
      CREATE TABLE place_sources (
        id bigserial PRIMARY KEY, entity_type text, place_id bigint,
        source text, source_id text, source_url text, license text, attribution text,
        data jsonb, match_confidence numeric, match_method text,
        retrieved_at timestamptz, updated_at timestamptz,
        UNIQUE(entity_type, source, source_id)
      );
      INSERT INTO taco_places (id,website_url,scrape_method,last_enriched_at,personal_rating,notes) VALUES
        (1,'https://example.test/taco/1','fetch',NOW(),9,'private taco one'),
        (2,'https://example.test/taco/2','browser',NOW(),8,'private taco two'),
        (3,'https://example.test/taco/3',NULL,NOW(),7,'not scraped');
      INSERT INTO pizza_places (id,website_url,scrape_method,last_enriched_at,personal_rating,notes) VALUES
        (1,'https://example.test/pizza/1','fetch',NOW(),6,'private pizza');
      GRANT USAGE ON SCHEMA ${schema} TO ${role};
      GRANT SELECT ON taco_places,pizza_places TO ${role};
      GRANT SELECT,INSERT,UPDATE ON place_sources TO ${role};
      GRANT USAGE,SELECT ON SEQUENCE place_sources_id_seq TO ${role};
    `);
    const url = new URL(adminUrl);
    const env = {
      PATH: process.env.PATH, PGHOST: url.hostname, PGPORT: url.port || '5432',
      PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGUSER: role,
      [['PG', 'PASSWORD'].join('')]: password,
      PGOPTIONS: `-c search_path=${schema},pg_catalog`,
    };
    const run = (args, overrides = {}) => execute(process.execPath, [script, ...args], {
      cwd, env: { ...env, ...overrides }, timeout: 20000,
    });
    const snapshot = async () => (await admin.query(`
      SELECT 'taco' AS entity,id,personal_rating,notes FROM taco_places
      UNION ALL SELECT 'pizza',id,personal_rating,notes FROM pizza_places ORDER BY entity,id
    `)).rows;
    const privateBefore = await snapshot();
    assert.match((await run(['--entity', 'taco', '--ids', '1', '--dry-run'])).stdout, /eligible: 1/);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM place_sources')).rows[0].n, 0);
    assert.match((await run(['--entity', 'taco', '--ids', '1'])).stdout, /upserted: 1/);
    assert.match((await run(['2', 'taco', '--ids', '1'])).stdout, /upserted: 1/);
    assert.match((await run(['--ids', '2', '--dry-run'], { APIZZA_SYNC_ENTITY: 'taco' })).stdout, /eligible: 1/);
    assert.match((await run(['--entity', 'taco', '--ids', '3'])).stdout, /upserted: 0/);
    // Flags in argv[0]/argv[1] must not be mistaken for a positional entity.
    assert.match((await run(['--hours', '2'])).stdout, /upserted: 1/);
    assert.match((await run(['--ids', '1', '--dry-run'])).stdout, /eligible: 1/);
    assert.deepEqual((await admin.query(`
      SELECT entity_type,place_id::int,source,source_url FROM place_sources ORDER BY entity_type,place_id
    `)).rows, [
      { entity_type: 'pizza', place_id: 1, source: 'official_website', source_url: 'https://example.test/pizza/1' },
      { entity_type: 'taco', place_id: 1, source: 'official_website', source_url: 'https://example.test/taco/1' },
    ]);
    assert.deepEqual(await snapshot(), privateBefore);
    assert.equal((await admin.query(`SELECT has_table_privilege($1, '${schema}.taco_places', 'UPDATE') AS allowed`, [role])).rows[0].allowed, false);
  } finally {
    if (createdSchema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    if (createdRole) await admin.query(`DROP ROLE ${role}`);
    await admin.end();
    await rm(cwd, { recursive: true });
  }
});
