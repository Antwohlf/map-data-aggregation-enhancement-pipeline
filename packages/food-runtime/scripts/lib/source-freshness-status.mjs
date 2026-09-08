export function summarizeDatabaseError(error) {
  const nested = Array.isArray(error?.errors)
    ? error.errors.map(item => item?.message || item).join(' ')
    : '';
  const fallback = typeof error === 'string' ? error : '';
  const raw = String(error?.message || nested || fallback).replace(/\s+/g, ' ').trim();
  if (/ECONNREFUSED/i.test(raw)) return 'local Postgres is not accepting connections';
  if (/ETIMEDOUT|timeout/i.test(raw)) return 'local Postgres connection timed out';
  return raw.slice(0, 240) || 'local Postgres check failed';
}
