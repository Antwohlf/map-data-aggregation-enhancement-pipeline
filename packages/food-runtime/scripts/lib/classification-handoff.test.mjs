import assert from 'node:assert/strict'
import test from 'node:test'

import { enqueueClassificationHandoff } from './classification-handoff.mjs'

test('a fresh Taco scrape hands off to the Taco classifier queue', () => {
  const calls = []
  const queue = { addJob: (...args) => { calls.push(args); return true } }
  assert.equal(enqueueClassificationHandoff(queue, { osmId: 'osm:node/42', placeType: 'taco' }, { state: 'MI' }), true)
  assert.deepEqual(calls, [['classify', 'osm:node/42', 'taco', { state: 'MI' }]])
})

test('classification handoff preserves Pizza and skips already classified rows', () => {
  const calls = []
  const queue = { addJob: (...args) => { calls.push(args); return true } }
  enqueueClassificationHandoff(queue, { osmId: 'osm:node/7', placeType: 'pizza' }, { state: 'NY' })
  assert.equal(enqueueClassificationHandoff(queue, { osmId: 'osm:node/8', placeType: 'taco' }, { style: 'Birria' }), false)
  assert.deepEqual(calls[0].slice(0, 3), ['classify', 'osm:node/7', 'pizza'])
  assert.throws(() => enqueueClassificationHandoff(queue, { osmId: 'x', placeType: 'burger' }), /Unsupported/)
})
