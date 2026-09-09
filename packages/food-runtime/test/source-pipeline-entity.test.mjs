import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  assertSourcePipelineEntity,
  defaultSourcePipelineConfigPath,
  isSourceCandidateForEntity,
  sourceInputSampleReportArguments,
  sourcePipelineOsmOutputPath,
  sourcePipelineOvertureOutputPath,
  sourcePipelineReviewOutputPath,
} from '../scripts/lib/source-pipeline-entity.mjs';
import { loadScopeConfig, normalizeSourceRow } from '../scripts/ops/source-input-sample-report.mjs';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PIZZA_CONFIG_PATH = resolve(PACKAGE_ROOT, 'config/source-pipeline.json');
const TACO_CONFIG_PATH = resolve(PACKAGE_ROOT, 'config/source-pipeline-taco.json');
const PIZZA_CONFIG = JSON.parse(readFileSync(PIZZA_CONFIG_PATH, 'utf8'));
const TACO_CONFIG = JSON.parse(readFileSync(TACO_CONFIG_PATH, 'utf8'));

test('pizza and taco candidates use separate entity predicates', () => {
  const pizza = {
    name: "Buddy's Pizza",
    categories: ['Italian Restaurant'],
    website: 'https://buddyspizza.com',
    source_url: '',
  };
  const taco = {
    name: 'Taquería El Rey',
    categories: ['Mexican Restaurant'],
    website: 'https://example.test/menu/tacos',
    source_url: '',
  };

  assert.equal(isSourceCandidateForEntity(pizza, 'pizza'), true);
  assert.equal(isSourceCandidateForEntity(pizza, 'taco'), false);
  assert.equal(isSourceCandidateForEntity(taco, 'taco'), true);
  assert.equal(isSourceCandidateForEntity(taco, 'pizza'), false);
  assert.equal(isSourceCandidateForEntity({ ...pizza, name: 'Wood-Fired Flatbread' }, 'pizza'), true);
  assert.throws(() => isSourceCandidateForEntity(taco, 'burger'), /Unsupported source pipeline entity/);
});

test('both checked-in configs declare supported, distinct entities and scopes', () => {
  assert.equal(assertSourcePipelineEntity(PIZZA_CONFIG.entity), 'pizza');
  assert.equal(assertSourcePipelineEntity(TACO_CONFIG.entity), 'taco');
  assert.deepEqual(PIZZA_CONFIG.regions.map(region => region.key), ['MI', 'NY', 'CA', 'TX']);
  assert.deepEqual(TACO_CONFIG.regions.map(region => region.key), ['MI', 'NY']);
  assert.equal(defaultSourcePipelineConfigPath('pizza'), 'config/source-pipeline.json');
  assert.equal(defaultSourcePipelineConfigPath('taco'), 'config/source-pipeline-taco.json');

  assert.deepEqual(loadScopeConfig(PIZZA_CONFIG_PATH, 'pizza').regions.map(region => region.key), ['MI', 'NY', 'CA', 'TX']);
  assert.deepEqual(loadScopeConfig(TACO_CONFIG_PATH, 'taco').regions.map(region => region.key), ['MI', 'NY']);
  assert.throws(
    () => loadScopeConfig(PIZZA_CONFIG_PATH, 'taco'),
    /Scope config entity pizza does not match requested entity taco/,
  );
  assert.throws(
    () => loadScopeConfig(resolve(PACKAGE_ROOT, 'config/missing-source-pipeline.json'), 'pizza'),
    /Scope config not found/,
  );

  assert.equal(PIZZA_CONFIG.sources.overture_places.enabled, true);
  assert.equal(PIZZA_CONFIG.sources.overture_places.category_policy, 'overture-pizza-taxonomy-v1');
  assert.equal(PIZZA_CONFIG.stageAdapters.overture_places.acquisition, 'food-source-overture-v1');
  assert.equal(TACO_CONFIG.sources.overture_places.enabled, true);
  assert.equal(TACO_CONFIG.sources.overture_places.category_policy, 'overture-taco-taxonomy-v1');
  assert.equal(TACO_CONFIG.stageAdapters.overture_places.acquisition, 'food-source-overture-taco-v1');
});

test('OSM resumable output identity is entity-specific', () => {
  assert.equal(
    sourcePipelineOsmOutputPath(PACKAGE_ROOT, 'MI', 'pizza'),
    resolve(PACKAGE_ROOT, 'reports/osm/mi-pizza.json'),
  );
  assert.equal(
    sourcePipelineOsmOutputPath(PACKAGE_ROOT, 'MI', 'taco'),
    resolve(PACKAGE_ROOT, 'reports/osm/mi-taco.json'),
  );
});

test('Overture v2 resumable output identity is entity-specific', () => {
  assert.equal(
    sourcePipelineOvertureOutputPath(PACKAGE_ROOT, 'MI', 'pizza'),
    resolve(PACKAGE_ROOT, 'data/source-inputs/overture_places-mi-pizza-v2.json'),
  );
  assert.equal(
    sourcePipelineOvertureOutputPath(PACKAGE_ROOT, 'MI', 'taco'),
    resolve(PACKAGE_ROOT, 'data/source-inputs/overture_places-mi-taco-v2.json'),
  );
});

test('Overture taxonomy and record-source provenance survive normalization', () => {
  const normalized = normalizeSourceRow({
    id: 'gers-synthetic-taco',
    name: 'El Camino',
    lat: 42.3,
    lng: -83.1,
    primary_category: 'mexican_restaurant',
    basic_category: 'restaurant',
    taxonomy: { primary: 'mexican_restaurant', hierarchy: ['food_and_drink', 'restaurant', 'latin_american_restaurant', 'mexican_restaurant'], alternates: ['taco_restaurant'] },
    country: 'US',
    region: 'MI',
    overture_sources: [{ dataset: 'synthetic-provider', license: 'CDLA-Permissive-2.0' }],
    overture_release: '2026-08-19.0',
    overture_adapter: 'food-source-overture-taco-v1',
    overture_category_policy: 'overture-taco-taxonomy-v1',
    attribution_url: 'https://docs.overturemaps.org/attribution/',
  }, 'overture_places');

  assert.equal(isSourceCandidateForEntity(normalized, 'taco'), true);
  assert.equal(isSourceCandidateForEntity(normalized, 'pizza'), false);
  assert.equal(normalized.country, 'US');
  assert.equal(normalized.source_release, '2026-08-19.0');
  assert.equal(normalized.source_adapter, 'food-source-overture-taco-v1');
  assert.deepEqual(normalized.upstream_sources, [{ dataset: 'synthetic-provider', license: 'CDLA-Permissive-2.0' }]);
  assert(normalized.categories.includes('mexican_restaurant'));
  assert(normalized.categories.includes('taco_restaurant'));
});

test('review outputs preserve Pizza paths and isolate Taco artifacts', () => {
  assert.equal(
    sourcePipelineReviewOutputPath(PACKAGE_ROOT, 'osm', 'MI', 'pizza'),
    resolve(PACKAGE_ROOT, 'reports/source-review/osm-MI-review.json'),
  );
  assert.equal(
    sourcePipelineReviewOutputPath(PACKAGE_ROOT, 'osm', 'MI', 'taco'),
    resolve(PACKAGE_ROOT, 'reports/source-review/osm-MI-taco-review.json'),
  );
});

test('report command wires each entity to its selected config path', () => {
  const common = {
    source: 'osm',
    input: '/tmp/source-input.json',
    limit: 25,
    reviewOutput: '/tmp/source-review.json',
  };
  const pizzaArgs = sourceInputSampleReportArguments({
    ...common,
    entity: PIZZA_CONFIG.entity,
    scopeConfig: PIZZA_CONFIG_PATH,
  });
  const tacoArgs = sourceInputSampleReportArguments({
    ...common,
    entity: TACO_CONFIG.entity,
    scopeConfig: TACO_CONFIG_PATH,
  });

  const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];
  assert.equal(valueAfter(pizzaArgs, '--entity'), 'pizza');
  assert.equal(valueAfter(pizzaArgs, '--scope-config'), PIZZA_CONFIG_PATH);
  assert.equal(valueAfter(tacoArgs, '--entity'), 'taco');
  assert.equal(valueAfter(tacoArgs, '--scope-config'), TACO_CONFIG_PATH);
  assert.equal(tacoArgs.includes(PIZZA_CONFIG_PATH), false);
  assert.throws(
    () => sourceInputSampleReportArguments({ ...common, entity: 'burger', scopeConfig: PIZZA_CONFIG_PATH }),
    /Unsupported source pipeline entity/,
  );
});

test('source report CLI main guard follows a symlinked entrypoint', () => {
  const tempDirectory = mkdtempSync(join(realpathSync(tmpdir()), 'food-runtime-cli-'));
  const script = resolve(PACKAGE_ROOT, 'scripts/ops/source-input-sample-report.mjs');
  const symlink = join(tempDirectory, 'source-input-sample-report.mjs');
  try {
    symlinkSync(script, symlink);
    const result = spawnSync(process.execPath, [symlink, '--help'], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: node scripts\/ops\/source-input-sample-report\.mjs/);
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});
