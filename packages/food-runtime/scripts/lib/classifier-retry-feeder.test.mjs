import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyQueueCounts, parseRequeued, retryFeederPlan } from './classifier-retry-feeder.mjs'

test('classifyQueueCounts only counts classify jobs', () => {
  assert.deepEqual(classifyQueueCounts({
    byType: [
      { job_type: 'classify', status: 'pending', count: 1 },
      { job_type: 'classify', status: 'processing', count: 1 },
      { job_type: 'scrape', status: 'pending', count: 99 },
    ],
  }), { pending: 1, processing: 1 })
})

test('retryFeederPlan respects the high-water mark', () => {
  assert.deepEqual(retryFeederPlan({ pending: 1, processing: 0, highWater: 2, batchPerRun: 2, states: ['MI', 'NY'] }), {
    active: 1,
    capacity: 1,
    states: [{ state: 'MI', limit: 1 }],
  })
  assert.equal(retryFeederPlan({ pending: 2, processing: 0 }).capacity, 0)
})

test('parseRequeued reads bounded population output', () => {
  assert.equal(parseRequeued('Requeued 2 partial completed classify jobs'), 2)
  assert.equal(parseRequeued('Requeued 0 partial completed classify jobs'), 0)
  assert.equal(parseRequeued('no candidates'), 0)
})
