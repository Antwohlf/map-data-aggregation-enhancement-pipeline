import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeSyncStatusError } from './supabase-sync-status.mjs'

test('summarizes missing Supabase credentials', () => {
  assert.equal(
    summarizeSyncStatusError(new Error('Missing Supabase URL and/or key in .env.local')),
    'Supabase credentials are unavailable in .env.local',
  )
})

test('summarizes unavailable sync dependencies', () => {
  assert.equal(
    summarizeSyncStatusError(new Error('connect ECONNREFUSED 127.0.0.1:5432')),
    'local Postgres is not accepting connections',
  )
  assert.equal(
    summarizeSyncStatusError(new Error('database connection timeout')),
    'required sync dependency timed out',
  )
})

test('keeps unknown sync failures concise', () => {
  assert.equal(summarizeSyncStatusError(new Error('unexpected sync failure')), 'unexpected sync failure')
  assert.equal(summarizeSyncStatusError({}), 'sync status check failed')
})
