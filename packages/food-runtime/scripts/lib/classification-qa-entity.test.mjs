import assert from 'node:assert/strict'
import test from 'node:test'

import { classificationQaProfile, validClassificationStyle } from './classification-qa-entity.mjs'

test('classification QA resolves the Taco table without a Pizza fallback', () => {
  assert.equal(classificationQaProfile('pizza').table, 'pizza_places')
  assert.equal(classificationQaProfile('taco').table, 'taco_places')
  assert.throws(() => classificationQaProfile('burger'), /Unsupported/)
})

test('classification QA validates single Pizza styles and multi-value Taco types', () => {
  assert.equal(validClassificationStyle('Detroit', 'pizza'), true)
  assert.equal(validClassificationStyle('Ground Beef, Pollo', 'taco'), true)
  assert.equal(validClassificationStyle('Ground Beef, Chicken', 'taco'), false)
  assert.equal(validClassificationStyle('Detroit', 'taco'), false)
})
