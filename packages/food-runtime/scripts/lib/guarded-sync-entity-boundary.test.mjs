import assert from 'node:assert/strict'
import test from 'node:test'

import {
  bulkRpcStatusArgs,
  classificationQaArgs,
  classifierHealthArgs,
  syncReadinessArgs,
} from './guarded-sync-entity-boundary.mjs'

const tacoOptions = Object.freeze({
  entity: 'taco',
  ids: [17, 19],
  hours: 6,
  batch: 25,
  sample: 3,
  lifecycleOnly: false,
  reconcile: false,
  checkpoint: 'scripts/.taco-supabase-sync-checkpoint.json',
})

test('every guarded read gate receives the exact Taco entity', () => {
  for (const args of [
    classifierHealthArgs('taco'),
    classificationQaArgs(tacoOptions),
    bulkRpcStatusArgs(tacoOptions),
    syncReadinessArgs(tacoOptions),
  ]) {
    const index = args.indexOf('--entity')
    assert.notEqual(index, -1)
    assert.equal(args[index + 1], 'taco')
    assert.doesNotMatch(args.join(' '), /--entity pizza/)
  }
})

test('guarded entity args reject unknown products', () => {
  assert.throws(() => classifierHealthArgs('burger'), /Unsupported/)
  assert.throws(() => classificationQaArgs({ ...tacoOptions, entity: 'burger' }), /Unsupported/)
})
