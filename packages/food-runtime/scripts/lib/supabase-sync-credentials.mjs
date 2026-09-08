/**
 * Resolve credentials for the local-to-Supabase sync boundary.
 *
 * Read-only previews may use the public key. Any live write must use the
 * service-role key because the guarded RPC and reviewed-new inserts are not
 * public operations.
 */
export function resolveSupabaseSyncCredentials(env = {}, { dryRun = false } = {}) {
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY
  const publicKey = env.VITE_SUPABASE_ANON_KEY

  if (!url) {
    throw new Error('Missing VITE_SUPABASE_URL in .env.local')
  }

  if (!dryRun && !serviceRoleKey) {
    throw new Error('Live Supabase sync requires SUPABASE_SERVICE_ROLE_KEY in .env.local')
  }

  const key = serviceRoleKey || publicKey
  if (!key) {
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY or VITE_SUPABASE_ANON_KEY in .env.local')
  }

  return {
    url,
    key,
    keyType: serviceRoleKey ? 'service_role' : 'public',
  }
}
