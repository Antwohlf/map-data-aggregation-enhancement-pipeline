import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPrompt } from '../enrichment/agents/llm-classifier.mjs'
import { hasPriceEvidence, hasTacoTypeEvidence } from './style-evidence.mjs'

const row = notes => ({ name: 'La Rosita', website_url: 'https://example.test', scrape_method: 'fetch', scrape_notes: JSON.stringify(notes), osm_tags: {}, source_evidence: [] })

test('Taco prompt carries protein hints and text when JSON-LD is generic', () => {
  const prompt = buildPrompt(row({ jsonld: [{ '@type': 'Restaurant', name: 'La Rosita', servesCuisine: 'Mexican' }], protein_hints: ['carnitas'] }), 'taco')
  assert.match(prompt, /protein_hints/)
  assert.match(prompt, /carnitas/)
  const withText = buildPrompt(row({ jsonld: [{ '@type': 'Restaurant', name: 'La Rosita' }], text_excerpt: 'Seasonal tacos and house-made salsas' }), 'taco')
  assert.match(withText, /text_excerpt/)
})

test('Taco labels and prices require source evidence, independently', () => {
  const noEvidence = row({ jsonld: [{ name: 'La Rosita', priceRange: '$$' }] })
  assert.equal(hasTacoTypeEvidence(noEvidence, 'Carnitas'), false)
  assert.equal(hasPriceEvidence(noEvidence, '$$'), true)
  assert.equal(hasPriceEvidence(row({ jsonld: [{ name: 'La Rosita' }] }), '$$'), false)
  assert.equal(hasTacoTypeEvidence(row({ text_excerpt: 'Tacos de carnitas' }), 'Carnitas'), true)
})

test('price evidence requires the exact explicit band, not arbitrary dollar signs or previous answers', () => {
  assert.equal(hasPriceEvidence(row({ text_excerpt: 'Tacos $5; plates $15' }), '$'), false)
  assert.equal(hasPriceEvidence(row({ jsonld: [{ priceRange: '$$$' }] }), '$$'), false)
  assert.equal(hasPriceEvidence(row({ price_hint: '$$' }), '$$'), true)
  assert.equal(hasPriceEvidence({ price_range: '$$', source_evidence: [] }, '$$'), false)
  assert.equal(hasPriceEvidence({ source_evidence: [{ data: { price_range: '$$' } }] }, '$$'), true)
})

test('classifier CLI still executes through the prepared workspace symlink', () => {
  const directory = mkdtempSync(join(tmpdir(), 'classifier-cli-'))
  try {
    const link = join(directory, 'classifier.mjs')
    symlinkSync(fileURLToPath(new URL('../enrichment/agents/llm-classifier.mjs', import.meta.url)), link)
    const result = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /Usage:/)
  } finally { rmSync(directory, { recursive: true }) }
})
