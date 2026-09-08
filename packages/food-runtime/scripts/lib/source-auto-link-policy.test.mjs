import test from 'node:test'
import assert from 'node:assert/strict'
import { sourceAutoLinkArguments, sourceAutoLinkMode } from './source-auto-link-policy.mjs'

test('uses exact source identity for OSM', () => {
  assert.deepEqual(sourceAutoLinkArguments('osm'), ['--exact-source-id'])
  assert.equal(sourceAutoLinkMode('osm'), '--exact-source-id')
})

test('uses Wikidata identity for Wikidata rows without chain flags', () => {
  assert.deepEqual(sourceAutoLinkArguments('wikidata'), ['--source-identity'])
  assert.equal(sourceAutoLinkMode('wikidata'), '--source-identity')
})

test('requires all identifiers for official chain rows', () => {
  assert.deepEqual(sourceAutoLinkArguments('all_the_places'), [
    '--exact-identifiers',
    '--min-exact-identifiers',
    '3',
  ])
})

test('leaves unvalidated provider sources for review', () => {
  for (const source of ['fsq_os_places', 'overture_places', 'official_website', 'unknown']) {
    assert.deepEqual(sourceAutoLinkArguments(source), [])
    assert.equal(sourceAutoLinkMode(source), null)
  }
})
