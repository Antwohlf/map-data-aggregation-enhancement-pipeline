import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { makeSyncRunState, readSyncRunState, summarizeSyncFailure, writeSyncRunState } from './supabase-sync-run-state.mjs'

test('builds a credential-free running state with sync scope', () => {
  const state = makeSyncRunState({
    state: 'running',
    startedAt: '2026-07-25T12:00:00.000Z',
    options: { hours: 168, batch: 100, maxBatches: 1, runReconciliation: false },
  })

  assert.equal(state.state, 'running')
  assert.equal(state.finished_at, null)
  assert.deepEqual(state.scope, {
    entity: 'pizza',
    hours: '168',
    batch: '100',
    max_batches: '1',
    reconciliation: false,
  })
  assert.equal(Object.keys(state).includes('SUPABASE_SERVICE_ROLE_KEY'), false)
})

test('writes status atomically and calculates duration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'apizza-sync-state-'))
  const path = join(directory, 'status.json')
  const state = makeSyncRunState({
    state: 'succeeded',
    startedAt: '2026-07-25T12:00:00.000Z',
    finishedAt: '2026-07-25T12:00:02.500Z',
    exitCode: 0,
    reason: 'bounded sync completed',
  })

  writeSyncRunState(path, state)
  assert.deepEqual(readSyncRunState(path), state)
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), state)
})

test('summarizes preflight failures without stack traces', () => {
  assert.equal(
    summarizeSyncFailure('supabase-sync-status-report failed: Missing Supabase URL and/or key in .env.local at main (file:///repo/report.mjs:12:3)'),
    'Supabase credentials are unavailable in .env.local',
  )
  assert.equal(summarizeSyncFailure('Error: connect ECONNREFUSED 127.0.0.1:5432 at Client.connect'), 'local Postgres or Supabase connection was refused')
  assert.equal(summarizeSyncFailure('sync failed at main (file:///repo/sync.mjs:2:1)'), 'sync failed')
})
