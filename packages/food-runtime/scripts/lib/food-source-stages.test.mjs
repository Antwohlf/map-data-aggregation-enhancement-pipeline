import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { executeTrustedHostStages } from '../../../executor/trusted-host.mjs';
import { createFoodSourceStages } from './food-source-stages.mjs';

for (const [name, entity] of [['source-pipeline', 'pizza'], ['source-pipeline-taco', 'taco']]) {
  const config = JSON.parse(readFileSync(new URL(`../../config/${name}.json`, import.meta.url)));
  test(`${entity} configured source graphs carry direct outputs in acquisition/match/review order`, () => {
    for (const [source, adapterIds] of Object.entries(config.stageAdapters)) {
      const calls = [];
      const graph = createFoodSourceStages({ source, adapterIds,
        acquire: context => { calls.push('acquire'); assert.equal(context.entity, entity); return { input: 'synthetic-input' }; },
        match: (_, inputs) => { calls.push('match'); assert.deepEqual(Object.keys(inputs), ['acquire']); assert.equal(inputs.acquire.input, 'synthetic-input'); return { input: 'stamped-input', report: 'review-report' }; },
        review: (_, inputs) => { calls.push('review'); assert.deepEqual(Object.keys(inputs), ['match']); return { ...inputs.match, osmProvenanceRefresh: null }; },
      });
      const result = executeTrustedHostStages({ ...graph, context: { entity } });
      assert.deepEqual(calls, ['acquire', 'match', 'review']);
      assert.deepEqual(result.outputs.review, { input: 'stamped-input', report: 'review-report', osmProvenanceRefresh: null });
    }
  });
  test(`${entity} rejects unknown selections before acquisition and stops review after match failure`, () => {
    let effects = 0;
    const callbacks = { acquire: () => { effects++; return {}; }, match: () => { throw new Error('matching failed'); }, review: () => { effects++; } };
    assert.throws(() => createFoodSourceStages({ source: 'osm', adapterIds: { ...config.stageAdapters.osm, review: 'unregistered' }, ...callbacks }), /Unknown/);
    assert.equal(effects, 0);
    const graph = createFoodSourceStages({ source: 'osm', adapterIds: config.stageAdapters.osm, ...callbacks });
    assert.throws(() => executeTrustedHostStages(graph), /matching failed/);
    assert.equal(effects, 1);
  });
}
