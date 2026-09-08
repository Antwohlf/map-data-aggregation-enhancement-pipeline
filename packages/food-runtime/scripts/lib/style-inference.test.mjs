import test from 'node:test'
import assert from 'node:assert/strict'
import { inferStyleFromBrandWikidata } from './style-inference.mjs'

test('uses a small verified brand catalog before display-name inference', () => {
  assert.equal(inferStyleFromBrandWikidata('Q15109854').style, 'California')
  assert.equal(inferStyleFromBrandWikidata('Q7897209').style, 'Chicago Deep Dish')
  assert.equal(inferStyleFromBrandWikidata('Q5652393').style, 'Standard Round')
})

test('does not classify unknown brand identifiers', () => {
  assert.equal(inferStyleFromBrandWikidata('Q132736386').style, null)
  assert.equal(inferStyleFromBrandWikidata(null).style, null)
})
