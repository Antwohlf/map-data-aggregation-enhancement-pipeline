import assert from 'node:assert/strict';
import test from 'node:test';

import { executeTrustedHostStages, executeTrustedHostStagesAsync } from './trusted-host.mjs';

const definition = (id, sourceAdapter) => ({
  schemaVersion: 1,
  id,
  stages: [
    { id: 'review', adapter: 'review', version: 1, kind: 'review', dependsOn: ['normalize'], config: { threshold: 2 } },
    { id: 'source', adapter: sourceAdapter, version: 1, kind: 'source', dependsOn: [], config: { seed: id } },
    { id: 'normalize', adapter: 'normalize', version: 1, kind: 'transform', dependsOn: ['source'], config: {} },
  ],
});

function registry(calls) {
  return [
    { id: 'pizza-source', version: 1, kind: 'source', run: ({ config }) => (calls.push(`pizza:${config.seed}`), [2, 1]) },
    { id: 'taco-source', version: 1, kind: 'source', run: ({ config }) => (calls.push(`taco:${config.seed}`), [4, 3]) },
    { id: 'normalize', version: 1, kind: 'transform', run: ({ inputs }) => (calls.push('normalize'), [...inputs.source].sort()) },
    { id: 'review', version: 1, kind: 'review', run: ({ inputs, config }) => (calls.push('review'), inputs.normalize.filter(value => value >= config.threshold)) },
  ];
}

test('two profiles interchange source adapters while sharing deterministic stages', () => {
  for (const [id, adapter, expected] of [['pizza', 'pizza-source', [2]], ['taco', 'taco-source', [3, 4]]]) {
    const calls = [];
    const events = [];
    const output = executeTrustedHostStages({ definition: definition(id, adapter), registry: registry(calls), context: { host: 'trusted' }, onEvent: value => events.push(value) });
    assert.deepEqual(output.order, ['source', 'normalize', 'review']);
    assert.deepEqual(output.outputs.review, expected);
    assert.deepEqual(calls, [`${id}:${id}`, 'normalize', 'review']);
    assert.equal(events.length, 6);
    assert.deepEqual(Object.keys(events[0]).sort(), ['adapter', 'definitionId', 'kind', 'stageId', 'type', 'version']);
  }
});

test('the complete definition and registry are validated before any adapter or event effect', () => {
  const invalid = [
    { ...definition('bad', 'pizza-source'), extra: true },
    { ...definition('bad', 'pizza-source'), stages: [...definition('bad', 'pizza-source').stages, definition('bad', 'pizza-source').stages[0]] },
    { ...definition('bad', 'pizza-source'), stages: [{ ...definition('bad', 'pizza-source').stages[0], dependsOn: ['absent'] }] },
    { ...definition('bad', 'pizza-source'), stages: [{ id: 'a', adapter: 'review', version: 1, kind: 'review', dependsOn: ['b'], config: {} }, { id: 'b', adapter: 'review', version: 1, kind: 'review', dependsOn: ['a'], config: {} }] },
    { ...definition('bad', 'pizza-source'), stages: definition('bad', 'pizza-source').stages.map((stage, index) => index ? stage : { ...stage, version: 2 }) },
    { ...definition('bad', 'pizza-source'), stages: definition('bad', 'pizza-source').stages.map((stage, index) => index ? stage : { ...stage, config: { value: undefined } }) },
  ];
  for (const value of invalid) {
    const calls = [];
    const events = [];
    assert.throws(() => executeTrustedHostStages({ definition: value, registry: registry(calls), onEvent: event => events.push(event) }));
    assert.deepEqual(calls, []);
    assert.deepEqual(events, []);
  }
});

test('only direct predecessor outputs are passed and a failure stops downstream stages', () => {
  const seen = [];
  const value = definition('failure', 'pizza-source');
  value.stages.push({ id: 'output', adapter: 'output', version: 1, kind: 'output', dependsOn: ['review'], config: {} });
  const adapters = registry(seen);
  adapters.find(entry => entry.id === 'review').run = ({ inputs }) => {
    assert.deepEqual(Object.keys(inputs), ['normalize']);
    assert.equal(Object.isFrozen(inputs), true);
    throw new Error('review failed');
  };
  adapters.push({ id: 'output', version: 1, kind: 'output', run: () => seen.push('must-not-run') });
  const events = [];
  assert.throws(() => executeTrustedHostStages({ definition: value, registry: adapters, onEvent: event => events.push(event) }), /review failed/);
  assert.equal(seen.includes('must-not-run'), false);
  assert.equal(events.at(-1).type, 'stage_failed');
  assert.equal(events.some(item => item.stageId === 'output'), false);
});

test('sync rejects thenables and async awaits stages while stopping on rejection', async () => {
  const value = { schemaVersion: 1, id: 'async', stages: [
    { id: 'first', adapter: 'first', version: 1, kind: 'maintenance', dependsOn: [], config: {} },
    { id: 'later', adapter: 'later', version: 1, kind: 'maintenance', dependsOn: ['first'], config: {} },
  ] };
  const calls = [];
  const adapters = [
    { id: 'first', version: 1, kind: 'maintenance', run: async () => { calls.push('first'); throw new Error('async failure'); } },
    { id: 'later', version: 1, kind: 'maintenance', run: () => calls.push('later') },
  ];
  const thenableAdapters = [
    { id: 'first', version: 1, kind: 'maintenance', run: () => Promise.resolve('async') },
    adapters[1],
  ];
  assert.throws(() => executeTrustedHostStages({ definition: value, registry: thenableAdapters }), /thenable/);
  calls.length = 0;
  await assert.rejects(executeTrustedHostStagesAsync({ definition: value, registry: adapters }), /async failure/);
  assert.deepEqual(calls, ['first']);
});
