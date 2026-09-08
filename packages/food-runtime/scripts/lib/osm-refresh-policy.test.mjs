import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldDeferTileRetry } from './osm-refresh-policy.mjs'

const now = Date.parse('2026-07-25T12:00:00.000Z')

test('defers failed and partial tiles during their cooldown', () => {
  const nextRetryAt = '2026-07-25T13:00:00.000Z'
  assert.equal(shouldDeferTileRetry({ status: 'failed', next_retry_at: nextRetryAt }, { now }), true)
  assert.equal(shouldDeferTileRetry({ status: 'partial', next_retry_at: nextRetryAt }, { now }), true)
})

test('allows forced retries and expired cooldowns', () => {
  const nextRetryAt = '2026-07-25T13:00:00.000Z'
  assert.equal(shouldDeferTileRetry({ status: 'partial', next_retry_at: nextRetryAt }, { now, retryFailed: true }), false)
  assert.equal(shouldDeferTileRetry({ status: 'partial', next_retry_at: nextRetryAt }, { now, resume: false }), false)
  assert.equal(shouldDeferTileRetry({ status: 'partial', next_retry_at: '2026-07-25T11:00:00.000Z' }, { now }), false)
})

test('does not defer successful or undated tiles', () => {
  assert.equal(shouldDeferTileRetry({ status: 'success' }, { now }), false)
  assert.equal(shouldDeferTileRetry({ status: 'partial' }, { now }), false)
})
