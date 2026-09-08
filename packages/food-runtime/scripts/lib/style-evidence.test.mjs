import test from 'node:test'
import assert from 'node:assert/strict'
import { evidenceText, hasPizzaSignal, hasStyleEvidence } from './style-evidence.mjs'

test('uses accepted source evidence when validating a classifier style', () => {
  const row = {
    name: 'Corner Pizzeria',
    source_evidence: [
      { source: 'official_website', data: { description: 'New York style pizza by the slice' } },
    ],
  }

  assert.match(evidenceText(row), /new york style pizza/)
  assert.equal(hasStyleEvidence(row, 'New York'), true)
  assert.equal(hasPizzaSignal(row), true)
})

test('keeps unsupported styles blocked when evidence is absent', () => {
  const row = { name: 'Corner Restaurant', source_evidence: [] }
  assert.equal(hasStyleEvidence(row, 'Detroit'), false)
})
