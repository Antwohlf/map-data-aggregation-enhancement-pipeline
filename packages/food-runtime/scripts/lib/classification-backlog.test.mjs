import test from 'node:test'
import assert from 'node:assert/strict'
import {
  estimateClassificationBacklog,
  summarizeClassificationBacklog,
} from './classification-backlog.mjs'

test('reports missing jobs before treating an empty queue as caught up', () => {
  assert.deepEqual(summarizeClassificationBacklog({
    ok: true,
    missingJob: 3,
    pending: 0,
    processing: 0,
    retryablePartial: 12,
    exhaustedPartial: 2,
  }), {
    state: 'unfed',
    recommendedAction: 'Populate 3 missing classify jobs before calling the backlog caught up.',
  })
})

test('reports active queue work before partial retries', () => {
  assert.equal(summarizeClassificationBacklog({
    ok: true,
    missingJob: 0,
    pending: 2,
    processing: 1,
    retryablePartial: 12,
    exhaustedPartial: 2,
  }).state, 'queued')
})

test('distinguishes retryable partial work from exhausted review work', () => {
  assert.equal(summarizeClassificationBacklog({ ok: true, retryablePartial: 12 }).state, 'partial_retry_pending')
  assert.equal(summarizeClassificationBacklog({ ok: true, exhaustedPartial: 2 }).state, 'manual_review')
})

test('reports a clear backlog and unavailable dependencies', () => {
  assert.equal(summarizeClassificationBacklog({ ok: true }).state, 'clear')
  assert.equal(summarizeClassificationBacklog({ ok: false }).state, 'unavailable')
})

test('estimates backlog duration from recent completed work', () => {
  assert.deepEqual(estimateClassificationBacklog({
    candidates: 2202,
    completedLastWindow: 16,
    windowHours: 1,
  }), {
    throughputPerHour: 16,
    estimatedHours: 137.625,
    estimatedDays: 5.734375,
    estimateState: 'estimated',
    estimateBasis: 'last 1h (16 completed)',
  })
})

test('does not invent an ETA when no work completed in the window', () => {
  assert.deepEqual(estimateClassificationBacklog({
    candidates: 10,
    completedLastWindow: 0,
    windowHours: 1,
  }), {
    throughputPerHour: 0,
    estimatedHours: null,
    estimatedDays: null,
    estimateState: 'unavailable',
    estimateBasis: 'last 1h; no completed jobs',
  })
})
