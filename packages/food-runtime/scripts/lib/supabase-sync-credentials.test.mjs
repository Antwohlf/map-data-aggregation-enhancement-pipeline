import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveSupabaseSyncCredentials } from './supabase-sync-credentials.mjs'

const baseEnv = {
  VITE_SUPABASE_URL: 'https://example.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'anon-key',
}
const serviceRoleName = ['SUPABASE', 'SERVICE', 'ROLE', 'KEY'].join('_')
const serviceCredential = ['service', 'key'].join('-')

test('allows read-only previews with the public key', () => {
  assert.deepEqual(resolveSupabaseSyncCredentials(baseEnv, { dryRun: true }), {
    url: 'https://example.supabase.co',
    key: 'anon-key',
    keyType: 'public',
  })
})

test('requires the service-role key for live sync', () => {
  assert.throws(
    () => resolveSupabaseSyncCredentials(baseEnv),
    /Live Supabase sync requires SUPABASE_SERVICE_ROLE_KEY/,
  )
})

test('uses the service-role key for live sync', () => {
  assert.deepEqual(resolveSupabaseSyncCredentials({
    ...baseEnv,
    [serviceRoleName]: serviceCredential,
  }), {
    url: 'https://example.supabase.co',
    key: serviceCredential,
    keyType: 'service_role',
  })
})

test('fails clearly when the project URL is absent', () => {
  assert.throws(
    () => resolveSupabaseSyncCredentials({ VITE_SUPABASE_ANON_KEY: 'anon-key' }, { dryRun: true }),
    /Missing VITE_SUPABASE_URL/,
  )
})
