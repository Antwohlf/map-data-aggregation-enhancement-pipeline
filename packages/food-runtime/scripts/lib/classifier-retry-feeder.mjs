export function classifyQueueCounts(stats) {
  const rows = (stats?.byType || []).filter(row => row.job_type === 'classify')
  return rows.reduce((counts, row) => {
    counts[row.status] = Number(row.count) || 0
    return counts
  }, { pending: 0, processing: 0 })
}

export function retryFeederPlan({
  pending = 0,
  processing = 0,
  highWater = 2,
  batchPerRun = 2,
  states = ['MI', 'NY'],
} = {}) {
  const active = Math.max(0, Number(pending) || 0) + Math.max(0, Number(processing) || 0)
  const capacity = Math.max(0, Math.min(
    Number(batchPerRun) || 0,
    (Number(highWater) || 0) - active,
  ))
  const selectedStates = states.slice(0, capacity).map(state => ({ state, limit: 1 }))
  return { active, capacity, states: selectedStates }
}

export function parseRequeued(output) {
  const match = String(output || '').match(/Requeued\s+(\d+)\s+partial completed classify jobs/i)
  return match ? Number(match[1]) : 0
}
