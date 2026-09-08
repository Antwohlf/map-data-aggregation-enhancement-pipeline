#!/usr/bin/env node

/**
 * Bounded, resumable OSM source export.
 *
 * The single-bbox exporter already owns Overpass query and endpoint failover
 * behavior. This runner adds geographic tiling, per-tile checkpoints, and
 * deduplication so one slow tile cannot discard an entire regional run.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { shouldDeferTileRetry } from '../lib/osm-refresh-policy.mjs'

const args = parseArgs(process.argv.slice(2))
const [south, west, north, east] = String(args.bbox || '').split(',').map(Number)
const output = args.output
const manifestPath = args.manifest || `${output}.manifest.json`
const step = positiveNumber(args.step, 0.5)
const maxTiles = positiveInt(args['max-tiles'], Number.MAX_SAFE_INTEGER)
const delayMs = nonNegativeInt(args['delay-ms'], 1500)
const tileTimeoutMs = positiveInt(process.env.OSM_TILE_TIMEOUT_MS, 240000)
const retryCooldownMs = positiveInt(process.env.OSM_RETRY_COOLDOWN_MS, 60 * 60 * 1000)
const subtileConcurrency = positiveInt(process.env.OSM_SUBTILE_CONCURRENCY, 2)
const maxRuntimeMs = positiveInt(process.env.OSM_EXPORT_MAX_RUNTIME_MS, 15 * 60 * 1000)
const refreshAfterHours = positiveInt(process.env.OSM_REFRESH_AFTER_HOURS, 30 * 24)
const refreshAfterMs = refreshAfterHours * 60 * 60 * 1000
const retryFailed = args['retry-failed'] === true || args['retry-failed'] === 'true'
const planOnly = args.plan === true || args.plan === 'true'
if (![south, west, north, east].every(Number.isFinite) || !output) {
  throw new Error('Usage: export-osm-tiles.mjs --bbox south,west,north,east --output file [--step 0.5] [--manifest file] [--plan]')
}
if (south >= north || west >= east || step <= 0) throw new Error('Invalid bbox or step')

const child = resolve(dirname(new URL(import.meta.url).pathname), 'export-osm-source.mjs')
const tiles = buildTiles(south, west, north, east, step)
const manifest = loadManifest(manifestPath, args.resume !== 'false')
if (args.resume !== 'false' && manifest.bbox && !sameNumbers(manifest.bbox, [south, west, north, east])) {
  throw new Error(`Manifest bbox mismatch for ${manifestPath}: existing=${manifest.bbox.join(',')} requested=${[south, west, north, east].join(',')}. Use a new manifest or --resume=false.`)
}
if (args.resume !== 'false' && manifest.step && Number(manifest.step) !== step) {
  throw new Error(`Manifest step mismatch for ${manifestPath}: existing=${manifest.step} requested=${step}. Use a new manifest or --resume=false.`)
}
manifest.bbox = [south, west, north, east]
manifest.step = step
manifest.total_tiles = tiles.length
manifest.tiles = manifest.tiles || {}

if (planOnly) {
  const now = Date.now()
  const statusCounts = Object.values(manifest.tiles).reduce((out, tile) => {
    out[tile.status] = (out[tile.status] || 0) + 1
    return out
  }, {})
  const nextTiles = []
  let deferredTiles = 0
  for (const tile of [...tiles].sort((left, right) => tilePriority(left, right, manifest, retryFailed))) {
    const prior = manifest.tiles[tileKey(tile)]
    const completedAt = prior?.completed_at ? Date.parse(prior.completed_at) : NaN
    const successIsFresh = prior?.status === 'success'
      && Number.isFinite(completedAt)
      && now - completedAt < refreshAfterMs
    if (successIsFresh && args.resume !== 'false') continue
    if (shouldDeferTileRetry(prior, { retryFailed, resume: args.resume !== 'false', now })) {
      deferredTiles += 1
      continue
    }
    nextTiles.push({
      key: tileKey(tile),
      bbox: tile.bbox,
      prior_status: prior?.status || 'unprocessed',
      retry_count: Number(prior?.retry_count || 0),
      next_retry_at: prior?.next_retry_at || null,
    })
  }
  const planLimit = Math.min(maxTiles, 25)
  console.log(JSON.stringify({
    mode: 'plan',
    source: 'osm',
    bbox: [south, west, north, east],
    step,
    manifest: manifestPath,
    total_tiles: tiles.length,
    status_counts: statusCounts,
    unprocessed_tiles: tiles.filter(tile => !manifest.tiles[tileKey(tile)]).length,
    retryable_tiles: nextTiles.length,
    deferred_tiles: deferredTiles,
    estimated_runs_at_max_tiles: maxTiles === Number.MAX_SAFE_INTEGER ? null : Math.ceil(nextTiles.length / maxTiles),
    next_tiles: nextTiles.slice(0, planLimit),
  }, null, 2))
  process.exit(0)
}

const rowsById = new Map()
for (const tile of Object.values(manifest.tiles)) {
  for (const row of tile.rows || []) rowsById.set(row.id, row)
}

let processed = 0
let deferred = 0
const startedAt = Date.now()
const orderedTiles = [...tiles].sort((left, right) => {
  const leftPrior = manifest.tiles[tileKey(left)]
  const rightPrior = manifest.tiles[tileKey(right)]
  const retryPriority = prior => {
    if (!prior || !['failed', 'partial'].includes(prior.status)) return 1
    if (retryFailed) return 0
    if (prior.next_retry_at && Date.parse(prior.next_retry_at) > Date.now()) return 2
    return 0
  }
  return retryPriority(leftPrior) - retryPriority(rightPrior)
})
for (const tile of orderedTiles) {
  if (Date.now() - startedAt >= maxRuntimeMs) break
  const key = tileKey(tile)
  const prior = manifest.tiles[key]
  const completedAt = prior?.completed_at ? Date.parse(prior.completed_at) : NaN
  const successIsFresh = prior?.status === 'success'
    && Number.isFinite(completedAt)
    && Date.now() - completedAt < refreshAfterMs
  if (successIsFresh && args.resume !== 'false') continue
  if (shouldDeferTileRetry(prior, { retryFailed, resume: args.resume !== 'false' })) {
    deferred += 1
    continue
  }
  if (processed >= maxTiles) break
  processed += 1

  const tileOutput = `${output}.${key}.json`
  try {
    const result = await runTile(tile, tileOutput, child, tileTimeoutMs, 0, prior?.subtiles)
    const rows = result.rows
    for (const row of rows) rowsById.set(row.id, row)
    manifest.tiles[key] = {
      ...tile,
      status: result.status || 'success',
      rows,
      output: tileOutput,
      stdout: result.stdout,
      retry_count: result.status === 'partial' ? Number(prior?.retry_count || 0) + 1 : 0,
      next_retry_at: result.status === 'partial'
        ? new Date(Date.now() + retryCooldownMs).toISOString()
        : null,
      ...(result.subtiles ? { subtiles: result.subtiles } : {}),
      completed_at: new Date().toISOString()
    }
  } catch (error) {
    const retryCount = Number(prior?.retry_count || 0) + 1
    const cooldown = Math.min(retryCooldownMs * (2 ** Math.max(0, retryCount - 1)), 6 * 60 * 60 * 1000)
    manifest.tiles[key] = {
      ...tile,
      status: 'failed',
      rows: [],
      retry_count: retryCount,
      next_retry_at: new Date(Date.now() + cooldown).toISOString(),
      ...(error.subtiles ? { subtiles: error.subtiles } : {}),
      error: String(error.stderr || error.message || error).trim().slice(-2000),
      completed_at: new Date().toISOString()
    }
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  if (delayMs) await sleep(delayMs)
}

const rows = [...rowsById.values()]
writeFileSync(output, `${JSON.stringify(rows, null, 2)}\n`)
const statuses = Object.values(manifest.tiles).reduce((out, tile) => {
  out[tile.status] = (out[tile.status] || 0) + 1
  return out
}, {})
writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, rows: rows.length, statuses, deferred_tiles: deferred, updated_at: new Date().toISOString() }, null, 2)}\n`)
console.log(JSON.stringify({ source: 'osm', rows: rows.length, output, manifest: manifestPath, tiles: tiles.length, processed, retry_failed: retryFailed, deferred_tiles: deferred, statuses }))
// Successful tiles are still valid source input. Keep failed/deferred tiles in
// the manifest for retry, but do not discard the rows already collected from
// successful tiles or block unrelated source processing.
if ((statuses.success || 0) === 0 && (statuses.failed || 0) > 0) process.exitCode = 1

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else out[key] = argv[++i]
  }
  return out
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function positiveNumber(value, fallback) {
  const parsed = Number.parseFloat(value || '')
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function nonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function sameNumbers(left, right) {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => Number(value) === Number(right[index]))
}

function tilePriority(left, right, manifest, retryFailed) {
  const leftPrior = manifest.tiles[tileKey(left)]
  const rightPrior = manifest.tiles[tileKey(right)]
  const retryPriority = prior => {
    if (!prior || !['failed', 'partial'].includes(prior.status)) return 1
    if (retryFailed) return 0
    if (prior.next_retry_at && Date.parse(prior.next_retry_at) > Date.now()) return 2
    return 0
  }
  return retryPriority(leftPrior) - retryPriority(rightPrior)
}

function buildTiles(s, w, n, e, size) {
  const result = []
  for (let lat = s; lat < n; lat += size) {
    for (let lng = w; lng < e; lng += size) {
      result.push({ bbox: [round(lat), round(lng), round(Math.min(lat + size, n)), round(Math.min(lng + size, e))] })
    }
  }
  return result
}

async function runTile(tile, tileOutput, child, timeoutMs, depth = 0, resumeSubtiles = null) {
  if (depth === 0 && Array.isArray(resumeSubtiles) && resumeSubtiles.length) {
    return runSubtiles(resumeSubtiles, child, timeoutMs, tileOutput, depth)
  }
  try {
    const stdout = await runChild([child, '--bbox', tile.bbox.join(','), '--output', tileOutput], timeoutMs)
    return { rows: JSON.parse(readFileSync(tileOutput, 'utf8')), stdout }
  } catch (error) {
    // One split level gives dense or geographically awkward tiles a bounded
    // recovery chance. Failed subtiles remain persisted for the next
    // scheduled attempt, so a source run never fans out indefinitely.
    if (depth >= 1 || !isTimeout(error)) throw error

    // Overpass can time out on a sparse-looking but geographically broad tile.
    // Split only the failed tile so the manifest remains resumable and the
    // successful subtiles can still contribute rows to the regional export.
    const subtiles = buildTiles(...tile.bbox, (tile.bbox[2] - tile.bbox[0]) / 2)
    return runSubtiles(subtiles, child, timeoutMs, tileOutput, depth + 1)
  }
}

async function runSubtiles(subtiles, child, timeoutMs, parentOutput, depth) {
    const results = []
    const descriptors = []
    const processSubtile = async (subtile, index) => {
      const subOutput = `${parentOutput}.sub${depth + 1}-${index}.json`
      if (subtile.status === 'success') {
        return {
          result: { rows: subtile.rows || [], stdout: subtile.stdout || '' },
          descriptor: subtile,
        }
      }
      try {
        const result = await runTile(subtile, subOutput, child, timeoutMs, depth)
        return {
          result,
          descriptor: {
            ...subtile,
            status: result.status || 'success',
            rows: result.rows,
            output: subOutput,
            stdout: result.stdout,
            ...(result.subtiles ? { subtiles: result.subtiles } : {}),
          },
        }
      } catch (error) {
        return {
          result: null,
          descriptor: {
            ...subtile,
            status: 'failed',
            rows: [],
            error: String(error.stderr || error.message || error).trim().slice(-2000),
          },
        }
      }
    }

    for (let start = 0; start < subtiles.length; start += subtileConcurrency) {
      const batch = subtiles.slice(start, start + subtileConcurrency)
      const batchResults = await Promise.all(batch.map((subtile, offset) => processSubtile(subtile, start + offset)))
      for (const item of batchResults) {
        if (item.result) results.push(item.result)
        descriptors.push(item.descriptor)
      }
    }
    const failed = descriptors.filter(subtile => subtile.status !== 'success')
    if (failed.length) {
    // Preserve successful subtiles even when one or more siblings fail. The
    // next run resumes only the failed subtiles instead of discarding useful
    // source rows already fetched during this attempt.
    return {
      status: 'partial',
      rows: [...new Map(results.flatMap(result => result.rows).map(row => [row.id, row])).values()],
      stdout: results.map(result => result.stdout).filter(Boolean).join('\n'),
      subtiles: descriptors,
    }
  }
  return {
      status: 'success',
      rows: [...new Map(results.flatMap(result => result.rows).map(row => [row.id, row])).values()],
      stdout: results.map(result => result.stdout).filter(Boolean).join('\n'),
      subtiles: descriptors,
    }
}

function runChild(childArgs, timeoutMs) {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, childArgs, {
      // These exporters do not spawn their own workers. Keeping them attached
      // makes timeout cleanup deterministic on macOS, where detached process
      // groups are not consistently addressable from Node.
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const rejectTimeout = () => {
      if (settled) return
      settled = true
      const error = new Error(`OSM child timed out after ${timeoutMs}ms`)
      error.code = 'ETIMEDOUT'
      error.stderr = stderr
      rejectChild(error)
    }
    const timer = setTimeout(() => {
      timedOut = true
      killChildProcess(child)
      // A descendant can inherit these pipes and prevent `close` from
      // arriving even after the process group has been signalled. Reject now
      // so the tile splitter/checkpoint loop can proceed deterministically.
      child.stdout.destroy()
      child.stderr.destroy()
      rejectTimeout()
    }, timeoutMs)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectChild(error)
    })
    child.once('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (timedOut) {
        const error = new Error(`OSM child timed out after ${timeoutMs}ms`)
        error.code = 'ETIMEDOUT'
        error.stderr = stderr
        rejectChild(error)
      } else if (code !== 0) {
        const error = new Error(`OSM child exited with code ${code}: ${stderr.trim().slice(-2000)}`)
        error.stderr = stderr
        rejectChild(error)
      } else {
        resolveChild(stdout.trim())
      }
    })
  })
}

function killChildProcess(child) {
  if (!child?.pid) return
  // The child is intentionally attached, so killing its PID is sufficient and
  // avoids leaving orphaned adaptive subtile requests on macOS.
  try { child.kill('SIGKILL') } catch {}
  try { spawnSync('/bin/kill', ['-KILL', String(child.pid)], { stdio: 'ignore' }) } catch {}
}

function isTimeout(error) {
  return error?.code === 'ETIMEDOUT' || /time(?:d\s*out|out)/i.test(String(error?.message || error?.stderr || ''))
}

function round(value) {
  return Number(value.toFixed(6))
}

function tileKey(tile) {
  return tile.bbox.map(value => String(value).replace('-', 'm').replace('.', 'p')).join('_')
}

function loadManifest(path, resume) {
  if (!resume || !existsSync(path)) return { version: 1, created_at: new Date().toISOString(), tiles: {} }
  return JSON.parse(readFileSync(path, 'utf8'))
}

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}
