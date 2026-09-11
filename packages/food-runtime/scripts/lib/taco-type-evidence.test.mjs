import assert from 'node:assert/strict'
import test from 'node:test'
import { hasTacoTypeEvidence } from './style-evidence.mjs'

test('Taco type evidence requires an explicit protein term in accepted input evidence', () => {
  const unsupported = { name: 'La Rosita', scrape_notes: JSON.stringify({ jsonld: [{ name: 'La Rosita', servesCuisine: 'Mexican' }] }) }
  assert.equal(hasTacoTypeEvidence(unsupported, 'Carnitas'), false)
  assert.equal(hasTacoTypeEvidence({ ...unsupported, scrape_notes: 'Tacos de carnitas y pollo' }, 'Carnitas'), true)
  assert.equal(hasTacoTypeEvidence({ ...unsupported, osm_tags: { cuisine: 'tacos al pastor' } }, 'Al Pastor'), true)
  assert.equal(hasTacoTypeEvidence({ ...unsupported, scrape_notes: 'Apollo restaurant' }, 'Pollo'), false)
})

test('Taco evidence guard permits null and rejects unknown values', () => {
  assert.equal(hasTacoTypeEvidence({}, null), true)
  assert.equal(hasTacoTypeEvidence({}, 'Not a taco type'), false)
})
