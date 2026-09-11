import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = resolve(packageRoot, 'scripts/ops/record-website-provenance.mjs');
const source = readFileSync(script, 'utf8');

test('provenance CLI preserves scheduler compatibility and validates bounded selectors', () => {
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /\[hours\] \[entity\]/);
  for (const args of [['--hours', '-1'], ['--entity', 'burger'], ['--ids', '1,1'], ['--ids', '0']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, args.join(' '));
  }
});

test('provenance uses configured database endpoint and parameterized exact-ID predicate', () => {
  assert.match(source, /env\.PGHOST \|\| env\.LOCAL_DB_HOST/);
  assert.match(source, /env\.PGPORT \|\| env\.LOCAL_DB_PORT/);
  assert.match(source, /env\.PGPASSWORD \|\| env\.LOCAL_DB_PASSWORD/);
  assert.match(source, /connectionTimeoutMillis: 15000/);
  assert.match(source, /statement_timeout: 30000/);
  assert.match(source, /id = ANY\(\$\$\{params\.length \+ 1\}::bigint\[\]\)/);
  assert.match(source, /options\.dryRun \?/);
  assert.doesNotMatch(source, /host: 'localhost', database: 'pizza_enrichment'/);
});

test('dry-run path is a SELECT and cannot execute the upsert template', () => {
  assert.match(source, /SELECT id\s+FROM \$\{table\}/s);
  assert.match(source, /INSERT INTO place_sources/s);
  assert.match(source, /official_website provenance rows eligible/);
});
