import { dirname, resolve } from 'path'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'

export function syncRunStatePath(value = 'scripts/.supabase-sync-status.json', cwd = process.cwd()) {
  return resolve(cwd, value)
}

export function writeSyncRunState(filePath, state) {
  const target = resolve(filePath)
  const temporary = `${target}.tmp-${process.pid}`
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, target)
  return target
}

export function readSyncRunState(filePath) {
  if (!existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return { state: 'unknown', reason: 'sync status file is unreadable' }
  }
}

export function summarizeSyncFailure(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (/missing supabase url and\/?or key/i.test(text)) return 'Supabase credentials are unavailable in .env.local'
  if (/econnrefused|connection refused/i.test(text)) return 'local Postgres or Supabase connection was refused'
  if (/timed out|timeout/i.test(text)) return 'sync preflight timed out'
  return (text.split(' at ')[0] || 'sync failed').slice(0, 280)
}

export function makeSyncRunState({
  state,
  startedAt,
  finishedAt = null,
  exitCode = null,
  reason = null,
  options = {},
  pid = process.pid,
} = {}) {
  const started = Date.parse(startedAt)
  const finished = finishedAt ? Date.parse(finishedAt) : NaN
  return {
    state,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Number.isFinite(started) && Number.isFinite(finished)
      ? Math.max(0, finished - started)
      : null,
    exit_code: exitCode,
    reason,
    pid,
    scope: {
      entity: String(options.entity ?? 'pizza'),
      hours: String(options.hours ?? ''),
      batch: String(options.batch ?? ''),
      max_batches: String(options.maxBatches ?? ''),
      reconciliation: Boolean(options.runReconciliation),
    },
  }
}
