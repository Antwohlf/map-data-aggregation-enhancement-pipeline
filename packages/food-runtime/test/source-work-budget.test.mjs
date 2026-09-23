import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { advanceSourceRegionIndex, nextSourceWorkUnitCount, selectSourceRegionIndex, sourceRegionIndexForRun } from '../scripts/lib/source-work-budget.mjs';

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

test('OSM planning applies the same failure rotation as execution', t => {
  const root = mkdtempSync(join(tmpdir(), 'taco-osm-rotation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statePath = join(root, 'state.json');
  const configPath = join(root, 'config.json');
  writeFileSync(statePath, JSON.stringify({ sources: { osm: { region_index: 0, consecutive_failures: 1 } } }));
  writeFileSync(configPath, JSON.stringify({
    entity: 'taco', operational_regions: ['MI', 'NY'],
    regions: [{ key: 'MI', bbox: [42, -85, 43, -84] }, { key: 'NY', bbox: [42, -78, 43, -77] }],
    sources: { osm: { enabled: true, failure_rotation_threshold: 1, regions_per_run: 1, capabilities: ['discover', 'match_existing', 'enrich_evidence'] } },
  }));
  const result = spawnSync(process.execPath, [runner, '--plan', '--source', 'osm', '--max-work-units', '2', '--json'], {
    cwd: root, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, SOURCE_PIPELINE_CONFIG: configPath, SOURCE_PIPELINE_STATE: statePath },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).work_units[0].region, 'NY');
});

test('regional cursor advances past every completed page and rotates only after the failure threshold', () => {
  assert.equal(sourceRegionIndexForRun(0, 0, 1, 3), 0);
  assert.equal(sourceRegionIndexForRun(0, 1, 1, 3), 1);
  assert.equal(advanceSourceRegionIndex(0, 2, 3), 2);
  assert.equal(advanceSourceRegionIndex(2, 2, 3), 1);
  assert.throws(() => advanceSourceRegionIndex(0, 0, 3), /Invalid source region cursor state/);
});

test('OSM failure rotation survives backlog prioritization across consecutive invocations', () => {
  const backlog = [100, 1]; // MI is persistently broken but has the largest refresh queue.
  let state = { region_index: 0, consecutive_failures: 0, failure_rotation_pending: false };

  const runAndFail = () => {
    const selected = selectSourceRegionIndex(
      state.region_index,
      state.consecutive_failures,
      1,
      backlog,
      state.failure_rotation_pending,
    );
    state = {
      region_index: (selected + 1) % backlog.length,
      consecutive_failures: 0,
      failure_rotation_pending: true,
    };
    return selected;
  };

  assert.equal(runAndFail(), 0, 'first invocation uses the largest backlog');
  assert.equal(runAndFail(), 1, 'second invocation honors failure rotation over backlog priority');
  assert.equal(runAndFail(), 0, 'the following invocation can retry the original region');
});
