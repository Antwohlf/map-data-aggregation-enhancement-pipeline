import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { nextSourceWorkUnitCount } from '../scripts/lib/source-work-budget.mjs';

const runner = fileURLToPath(new URL('../scripts/ops/run-source-pipeline.mjs', import.meta.url));
const config = fileURLToPath(new URL('../config/source-pipeline-taco.json', import.meta.url));

test('Taco plan can select both due FSQ and Overture within a two-unit run', t => {
  const root = mkdtempSync(join(tmpdir(), 'taco-source-budget-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = join(root, 'state.json');
  writeFileSync(statePath, JSON.stringify({ sources: { osm: { last_success: new Date().toISOString() } } }));
  const result = spawnSync(process.execPath, [runner, '--plan', '--source', 'fsq_os_places,overture_places', '--max-work-units', '2', '--json'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 30000,
    env: { ...process.env, SOURCE_PIPELINE_CONFIG: config, SOURCE_PIPELINE_STATE: statePath },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).work_units.map(unit => unit.source), ['fsq_os_places', 'overture_places']);

  // Execution charges one completed regional page per source. In particular,
  // FSQ must not consume a second unit after its review page already completed.
  const afterFsq = nextSourceWorkUnitCount(0, 2);
  const afterOverture = nextSourceWorkUnitCount(afterFsq, 2);
  assert.equal(afterOverture, 2);
  assert.throws(() => nextSourceWorkUnitCount(afterOverture, 2), /budget exceeded/);
});

test('work-unit accounting rejects invalid and over-budget updates', () => {
  assert.throws(() => nextSourceWorkUnitCount(-1, 2), /Invalid source work-unit budget/);
  assert.throws(() => nextSourceWorkUnitCount(0, 0), /Invalid source work-unit budget/);
  assert.throws(() => nextSourceWorkUnitCount(2, 2), /budget exceeded/);
});
