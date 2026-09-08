#!/usr/bin/env node
/**
 * Recover stale classify jobs whose owning classifier process is gone.
 *
 * This runs independently of the classifiers so a process blocked inside an
 * Ollama request cannot prevent its own queue cleanup. It never requeues a
 * job while the matching worker process is still present.
 */

import { execFileSync } from 'node:child_process'
import { getQueue } from '../enrichment/queue.mjs'

const apply = process.argv.includes('--apply')
const timeoutMinutes = Number.parseInt(process.env.CLASSIFIER_RECONCILE_STALE_MINUTES || '30', 10)
const queue = getQueue()

function liveWorkerIds() {
  let output = ''
  try {
    output = execFileSync('ps', ['ax', '-o', 'command='], { encoding: 'utf8' })
  } catch (error) {
    throw new Error(`Unable to inspect classifier processes: ${error.message}`)
  }
  return new Set([...output.matchAll(/scripts\/enrichment\/agents\/llm-classifier\.mjs(?:.*?--worker-id\s+(\S+))?/g)]
    .map(match => match[1])
    .filter(Boolean))
}

try {
  const jobs = queue.getStaleProcessingJobs(timeoutMinutes, 'classify')
  const active = liveWorkerIds()
  const candidates = jobs.filter(job => {
    if (!active.has(job.worker_id)) return true
    // A process can survive after its queue heartbeat has reset to idle. In
    // that contradictory state the job is orphaned even though the PID is
    // still visible, so do not let a stale row block the queue indefinitely.
    const worker = queue.db.prepare(`
      SELECT status, current_job_id
      FROM workers
      WHERE worker_id = ?
    `).get(job.worker_id)
    return worker?.status !== 'working' || Number(worker.current_job_id) !== Number(job.id)
  })
  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    timeout_minutes: timeoutMinutes,
    stale_jobs: jobs.length,
    live_worker_ids: [...active],
    candidates: candidates.map(job => job.id),
  }))
  if (apply) {
    for (const job of candidates) {
      queue.retry(job.id, `Reconciled stale classify job after worker process disappeared (${timeoutMinutes}m)`, { refundAttempt: true })
    }
    if (candidates.length) console.log(`requeued=${candidates.length}`)
  }
} finally {
  queue.close()
}
