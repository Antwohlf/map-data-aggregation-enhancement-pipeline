export const RETRYABLE_TILE_STATUSES = Object.freeze(['failed', 'partial'])

export function shouldDeferTileRetry(prior, {
  retryFailed = false,
  resume = true,
  now = Date.now(),
} = {}) {
  if (!resume || retryFailed || !RETRYABLE_TILE_STATUSES.includes(prior?.status)) return false
  const nextRetryAt = Date.parse(prior?.next_retry_at || '')
  return Number.isFinite(nextRetryAt) && nextRetryAt > now
}
