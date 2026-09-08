#!/usr/bin/env node
/**
 * Keep the single iMac classifier supplied with a small, bounded retry window.
 * This is intentionally separate from source discovery so a slow source cannot
 * starve partial classification recovery.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { getQueue } from '../enrichment/queue.mjs'
import { classifyQueueCounts, parseRequeued, retryFeederPlan } from '../lib/classifier-retry-feeder.mjs'

const ROOT = process.cwd()
const CONFIG_PATH = resolve(ROOT, 'config/source-pipeline.json')
const LOCK_PATH = process.env.CLASSIFIER_RETRY_FEEDER_LOCK || '/tmp/apizzamichigan/classifier-retry-feeder.lock'
const LOCK_MAX_AGE_MS = 10 * 60 * 1000
const apply = process.argv.includes('--apply')
const dryRun = process.argv.includes('--dry-run') || !apply

function acquireLock() {
  mkdirSync(resolve(LOCK_PATH, '..'), { recursive: true })
  try {
    mkdirSync(LOCK_PATH)
    return true
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    try {
      if (Date.now() - statSync(LOCK_PATH).mtimeMs > LOCK_MAX_AGE_MS) {
        rmSync(LOCK_PATH, { recursive: true, force: true })
        mkdirSync(LOCK_PATH)
        return true
      }
    } catch {}
    return false
  }
}

function releaseLock() {
  rmSync(LOCK_PATH, { recursive: true, force: true })
}

function runPopulation(state, limit) {
  const args = [
    resolve(ROOT, 'scripts/enrichment/populate-classify-from-db.mjs'),
    '--state', state,
    '--limit', String(limit),
    '--skip-existing',
    '--retry-partial',
  ]
  if (dryRun) args.push('--dry-run')
  try {
    return execFileSync(process.execPath, args, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120000,
      env: process.env,
    })
  } catch (error) {
    throw new Error(`classifier retry population failed for ${state}: ${error.stderr || error.message}`)
  }
}

async function main() {
  if (!existsSync(CONFIG_PATH)) throw new Error(`Missing ${CONFIG_PATH}`)
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  const feeder = config.classifier_retry_feeder || {}
  if (!feeder.enabled) {
    console.log(JSON.stringify({ mode: dryRun ? 'dry-run' : 'apply', state: 'disabled' }))
    return
  }
  if (!acquireLock()) {
    console.log(JSON.stringify({ mode: dryRun ? 'dry-run' : 'apply', state: 'locked' }))
    return
  }

  const queue = getQueue()
  try {
    const counts = classifyQueueCounts(queue.getStats())
    const plan = retryFeederPlan({
      pending: counts.pending,
      processing: counts.processing,
      highWater: feeder.high_water,
      batchPerRun: feeder.batch_per_run,
      states: feeder.states,
    })
    const result = {
      mode: dryRun ? 'dry-run' : 'apply',
      queue: counts,
      active: plan.active,
      capacity: plan.capacity,
      requeued: 0,
      states: [],
    }
    if (!plan.capacity) {
      result.state = 'at_capacity'
      console.log(JSON.stringify(result))
      return
    }
    let remaining = plan.capacity
    for (const state of feeder.states) {
      if (!remaining) break
      const item = { state, limit: 1 }
      const output = runPopulation(item.state, item.limit)
      const requeued = dryRun ? Number(output.match(/Eligible\s+(\d+)\s+partial/i)?.[1] || 0) : parseRequeued(output)
      result.requeued += requeued
      result.states.push({ state: item.state, limit: item.limit, requeued, output: output.trim() })
      remaining -= requeued
    }
    result.state = result.requeued ? 'fed' : 'empty'
    console.log(JSON.stringify(result))
  } finally {
    queue.close()
    releaseLock()
  }
}

main().catch(error => {
  console.error(`classifier retry feeder failed: ${error.message || error}`)
  process.exit(1)
})
