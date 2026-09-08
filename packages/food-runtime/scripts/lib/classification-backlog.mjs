/**
 * Translate classifier backlog counters into a human-readable operational
 * state. The counters are intentionally kept separate from queue mutation so
 * health reports remain read-only.
 */
export function summarizeClassificationBacklog(counts = {}) {
  if (counts.ok === false) {
    return {
      state: 'unavailable',
      recommendedAction: 'Restore the local database and queue connections before assessing classification work.',
    }
  }

  const missingJob = Number(counts.missingJob) || 0
  const pending = Number(counts.pending) || 0
  const processing = Number(counts.processing) || 0
  const retryablePartial = Number(counts.retryablePartial) || 0
  const exhaustedPartial = Number(counts.exhaustedPartial) || 0

  if (missingJob > 0) {
    return {
      state: 'unfed',
      recommendedAction: `Populate ${missingJob} missing classify job${missingJob === 1 ? '' : 's'} before calling the backlog caught up.`,
    }
  }

  if (pending > 0 || processing > 0) {
    return {
      state: 'queued',
      recommendedAction: `The classifier still has ${pending + processing} queued or active job${pending + processing === 1 ? '' : 's'}.`,
    }
  }

  if (retryablePartial > 0) {
    return {
      state: 'partial_retry_pending',
      recommendedAction: `${retryablePartial} partial result${retryablePartial === 1 ? '' : 's'} remain eligible for the bounded retry pass.`,
    }
  }

  if (exhaustedPartial > 0) {
    return {
      state: 'manual_review',
      recommendedAction: `${exhaustedPartial} partial result${exhaustedPartial === 1 ? '' : 's'} exhausted automatic retry and need editorial review.`,
    }
  }

  return {
    state: 'clear',
    recommendedAction: 'No classification backlog remains for the configured operational regions.',
  }
}

/**
 * Estimate time to clear the operational backlog from a recent completed-job
 * window. This is intentionally descriptive only; it never changes queue
 * state or assumes that every classification will succeed on the first pass.
 */
export function estimateClassificationBacklog({
  candidates = 0,
  completedLastWindow = 0,
  windowHours = 0,
} = {}) {
  const remaining = Math.max(0, Number(candidates) || 0)
  const completed = Math.max(0, Number(completedLastWindow) || 0)
  const hours = Math.max(0, Number(windowHours) || 0)
  const throughputPerHour = hours > 0 ? completed / hours : 0

  if (remaining === 0) {
    return {
      throughputPerHour,
      estimatedHours: 0,
      estimatedDays: 0,
      estimateState: 'clear',
      estimateBasis: completed > 0 ? `last ${hours}h` : null,
    }
  }

  if (throughputPerHour <= 0) {
    return {
      throughputPerHour: 0,
      estimatedHours: null,
      estimatedDays: null,
      estimateState: 'unavailable',
      estimateBasis: hours > 0 ? `last ${hours}h; no completed jobs` : 'no observation window',
    }
  }

  const estimatedHours = remaining / throughputPerHour
  return {
    throughputPerHour,
    estimatedHours,
    estimatedDays: estimatedHours / 24,
    estimateState: 'estimated',
    estimateBasis: `last ${hours}h (${completed} completed)`,
  }
}
