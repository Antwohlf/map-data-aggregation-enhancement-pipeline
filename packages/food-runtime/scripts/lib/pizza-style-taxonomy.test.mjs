import test from 'node:test'
import assert from 'node:assert/strict'
import { PIZZA_STYLES, normalizePizzaStyle } from './pizza-style-taxonomy.mjs'

test('normalizes canonical styles without changing their display spelling', () => {
  assert.equal(normalizePizzaStyle(' detroit '), 'Detroit')
  assert.equal(normalizePizzaStyle('NEW YORK'), 'New York')
  assert.equal(normalizePizzaStyle('new   haven /   connecticut'), 'New Haven / Connecticut')
})

test('normalizes legacy aliases and chooses the most specific recognized style', () => {
  assert.equal(normalizePizzaStyle('traditional'), 'Standard Round')
  assert.equal(normalizePizzaStyle('Chicago, sicilian, New York'), 'Sicilian')
})

test('uses null for blank input and Unknown for unsupported nonblank input', () => {
  assert.equal(normalizePizzaStyle(''), null)
  assert.equal(normalizePizzaStyle('Breakfast'), 'Unknown')
  assert.equal(normalizePizzaStyle('not a pizza style'), 'Unknown')
})

test('returns only values from the canonical taxonomy', () => {
  for (const input of ['Detroit', 'Traditional', 'Breakfast', '', 'New York']) {
    const normalized = normalizePizzaStyle(input)
    assert.ok(normalized === null || PIZZA_STYLES.includes(normalized))
  }
})
