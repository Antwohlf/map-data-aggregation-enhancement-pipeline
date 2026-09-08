export function summarizeSyncStatusError(error) {
  const fallback = typeof error === 'string' ? error : '';
  const raw = String(error?.message || fallback).replace(/\s+/g, ' ').trim();
  if (/Missing Supabase URL and\/or key/i.test(raw)) {
    return 'Supabase credentials are unavailable in .env.local';
  }
  if (/ECONNREFUSED/i.test(raw)) return 'local Postgres is not accepting connections';
  if (/ETIMEDOUT|timeout/i.test(raw)) return 'required sync dependency timed out';
  return raw.slice(0, 280) || 'sync status check failed';
}
