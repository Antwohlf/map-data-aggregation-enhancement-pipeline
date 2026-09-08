import assert from 'node:assert/strict'
import test from 'node:test'

import { enrichmentEntity } from './enrichment-entity.mjs'
import { inferTypeFromName } from './type-inference-tacos.mjs'

test('deterministic Taco chain output stays inside the product taxonomy', () => {
  const inferred = inferTypeFromName('Taco Bell')
  const taxonomy = new Set(enrichmentEntity('taco').taxonomy)
  assert.deepEqual(inferred.types, ['Ground Beef', 'Pollo'])
  assert.equal(inferred.types.every(type => taxonomy.has(type)), true)
})
