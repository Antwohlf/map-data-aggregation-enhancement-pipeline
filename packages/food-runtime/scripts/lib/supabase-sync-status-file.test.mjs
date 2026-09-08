import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultSyncStatusFile } from './supabase-sync-status-file.mjs'

test('keeps Pizza on the compatible status path and separates Taco state', () => {
  assert.equal(defaultSyncStatusFile('pizza'), 'scripts/.supabase-sync-status.json')
  assert.equal(defaultSyncStatusFile('taco'), 'scripts/.taco-supabase-sync-status.json')
})
