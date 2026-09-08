import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeOsmManifest } from './osm-refresh-summary.mjs'

test('counts failed and partial tiles in the OSM refresh queue', () => {
  const summary = summarizeOsmManifest({
    total_tiles: 10,
    tiles: {
      success: { status: 'success', completed_at: '2026-07-25T00:00:00.000Z' },
      partial: { status: 'partial' },
      failed: { status: 'failed' },
    },
  }, { now: Date.parse('2026-07-25T01:00:00.000Z') })

  assert.equal(summary.unprocessedTiles, 7)
  assert.equal(summary.retryableTiles, 2)
  assert.equal(summary.refreshQueueTiles, 9)
})

test('counts stale successful tiles without double-counting retries', () => {
  const summary = summarizeOsmManifest({
    total_tiles: 2,
    tiles: {
      stale: { status: 'success', completed_at: '2026-06-01T00:00:00.000Z' },
      fresh: { status: 'success', completed_at: '2026-07-25T00:00:00.000Z' },
    },
  }, { now: Date.parse('2026-07-25T01:00:00.000Z'), refreshAfterHours: 720 })

  assert.equal(summary.unprocessedTiles, 0)
  assert.equal(summary.staleTiles, 1)
  assert.equal(summary.refreshQueueTiles, 1)
})
