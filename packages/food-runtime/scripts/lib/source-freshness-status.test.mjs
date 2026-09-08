import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeDatabaseError } from './source-freshness-status.mjs'

test('summarizes refused Postgres connections', () => {
  assert.equal(
    summarizeDatabaseError(new Error('connect ECONNREFUSED 127.0.0.1:5432')),
    'local Postgres is not accepting connections',
  )
})

test('summarizes nested connection failures', () => {
  assert.equal(
    summarizeDatabaseError({
      name: 'AggregateError',
      errors: [new Error('connect ECONNREFUSED ::1:5432'), new Error('connect ECONNREFUSED 127.0.0.1:5432')],
    }),
    'local Postgres is not accepting connections',
  )
})

test('summarizes timeouts and unknown failures without a stack trace', () => {
  assert.equal(summarizeDatabaseError(new Error('database connection timeout')), 'local Postgres connection timed out')
  assert.equal(summarizeDatabaseError(new Error('unexpected database failure')), 'unexpected database failure')
  assert.equal(summarizeDatabaseError({}), 'local Postgres check failed')
})
