import assert from 'node:assert/strict'
import test from 'node:test'

import { guardedPublishArgs, reviewedNewTarget } from './reviewed-new-entity-boundary.mjs'

test('selects distinct reviewed-new canonical tables without a Pizza fallback', () => {
  assert.equal(reviewedNewTarget('pizza').canonicalTable, 'pizza_places')
  assert.equal(reviewedNewTarget('taco').canonicalTable, 'taco_places')
  assert.throws(() => reviewedNewTarget('burger'), /Unsupported/)
  assert.throws(() => reviewedNewTarget(), /Unsupported/)
})

test('forwards the exact entity to guarded publication', () => {
  const taco = guardedPublishArgs('taco', [17, 19])
  assert.deepEqual(taco.slice(0, 5), [
    'scripts/ops/guarded-supabase-sync.mjs',
    '--entity',
    'taco',
    '--ids',
    '17,19',
  ])
  assert.doesNotMatch(taco.join(' '), /--entity pizza/)
  assert.throws(() => guardedPublishArgs('burger', [1]), /Unsupported/)
})
