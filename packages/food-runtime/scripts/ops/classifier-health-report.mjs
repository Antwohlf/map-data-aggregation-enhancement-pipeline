#!/usr/bin/env node
/**
 * Read-only health summary for the launchd-managed classifier service.
 *
 * Intended for quick remote checks:
 *   node scripts/ops/classifier-health-report.mjs
 */

import Database from 'better-sqlite3'
import pg from 'pg'
import 'dotenv/config'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { execFileSync, spawnSync } from 'child_process'
import os from 'os'
import {
  estimateClassificationBacklog,
  summarizeClassificationBacklog,
} from '../lib/classification-backlog.mjs'
import { enrichmentEntity } from '../lib/enrichment-entity.mjs'
import { enrichmentProcessReport } from '../lib/enrichment-process-report.mjs'

const argv = process.argv.slice(2)
const args = new Set(argv)
const entityArgIndex = argv.indexOf('--entity')
if (entityArgIndex >= 0 && !argv[entityArgIndex + 1]) throw new Error('--entity requires pizza or taco')
const ENTITY_PROFILE = enrichmentEntity(entityArgIndex >= 0 ? argv[entityArgIndex + 1] : process.env.APIZZA_SYNC_ENTITY || 'pizza')

const SERVICE_LABEL = process.env.CLASSIFIER_SERVICE_LABEL || 'com.apizzamichigan.classifier'
const WORKER_ID = process.env.CLASSIFIER_WORKER_ID || 'launchd-classify'
const STALE_MINUTES = parsePositiveInt(process.env.CLASSIFIER_HEALTH_STALE_MINUTES, 30)
const WINDOW_HOURS = parsePositiveInt(process.env.CLASSIFIER_HEALTH_WINDOW_HOURS, 1)
const MAX_ROWS = parsePositiveInt(process.env.CLASSIFIER_HEALTH_MAX_ROWS, 5)
// The iMac runs one Ollama-backed classifier. Operators can explicitly raise
// this for a machine with enough local inference capacity.
const EXPECTED_CLASSIFIER_PROCESSES = parsePositiveInt(process.env.CLASSIFIER_WORKER_COUNT, 1)
const EXPECTED_SCRAPER_PROCESSES = parsePositiveInt(process.env.SCRAPER_PROCESS_COUNT, 1)
const IDLE_WARNING_MINIMUM = parsePositiveInt(process.env.CLASSIFIER_IDLE_WARNING_MINIMUM, 10)

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function run(cmd, cmdArgs = [], options = {}) {
  try {
    const stdout = execFileSync(cmd, cmdArgs, {
      encoding: 'utf8',
      timeout: options.timeout || 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options
    })
    return { ok: true, stdout: stdout.trim(), stderr: '', status: 0 }
  } catch (error) {
    return {
      ok: false,
      stdout: (error.stdout || '').toString().trim(),
      stderr: (error.stderr || error.message || '').toString().trim(),
      status: error.status ?? 1
    }
  }
}

function errorMessage(error) {
  return error?.message || error?.code || String(error)
}

function repoRoot() {
  const result = run('git', ['rev-parse', '--show-toplevel'])
  return result.ok ? result.stdout : process.cwd()
}

function gitReport(root) {
  const status = run('git', ['status', '--short', '--branch'], { cwd: root })
  return {
    branch: run('git', ['branch', '--show-current'], { cwd: root }).stdout || '(unknown)',
    head: run('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).stdout || '(unknown)',
    originMain: run('git', ['rev-parse', '--short', 'origin/main'], { cwd: root }).stdout || '(unknown)',
    clean: status.ok && status.stdout.split('\n').length === 1,
    status: status.stdout || '(status unavailable)'
  }
}

function launchdReport(label = SERVICE_LABEL) {
  if (os.platform() !== 'darwin') {
    return { ok: false, skipped: true, reason: 'launchd is macOS-only' }
  }

  const uid = run('id', ['-u'])
  if (!uid.ok) return { ok: false, error: uid.stderr || 'unable to resolve uid' }

  const service = `gui/${uid.stdout}/${label}`
  const result = run('launchctl', ['print', service], { timeout: 10000 })
  if (!result.ok) {
    return { ok: false, service, error: result.stderr || result.stdout || 'launchctl print failed' }
  }

  const state = result.stdout.match(/\bstate = ([^\n]+)/)?.[1]?.trim() || '(unknown)'
  const pid = result.stdout.match(/\bpid = ([0-9]+)/)?.[1] || null
  const runs = result.stdout.match(/\bruns = ([0-9]+)/)?.[1] || null
  const exitStatus = result.stdout.match(/\blast exit code = ([^\n]+)/)?.[1]?.trim() || null
  const signal = result.stdout.match(/\blast terminating signal = ([^\n]+)/)?.[1]?.trim() || null

  return {
    ok: state === 'running',
    service,
    state,
    pid,
    runs: runs ? Number.parseInt(runs, 10) : null,
    lastExitCode: exitStatus,
    lastTerminatingSignal: signal
  }
}

function processReport() {
  const ps = spawnSync('ps', ['ax', '-o', 'pid=,command='], { encoding: 'utf8' })
  if (ps.status !== 0) return { ok: false, error: ps.stderr?.trim() || 'ps failed' }

  return { ok: true, ...enrichmentProcessReport(ps.stdout) }
}

function tunnelReport() {
  const expectedService = 'com.apizzamichigan.laptop-ollama-tunnel'
  const result = spawnSync('lsof', ['-nP', '-iTCP:11435', '-sTCP:LISTEN'], { encoding: 'utf8' })
  if (result.status !== 0 && !result.stdout?.trim()) {
    return {
      ok: false,
      port: 11435,
      ownership: 'remote-laptop',
      expectedService,
      inspection: 'The laptop launchd owner is not inspectable from the iMac; verify the forwarded listener instead.',
      recovery: 'laptop launchd KeepAlive should restart the reverse SSH tunnel',
      error: result.stderr?.trim() || 'listener check failed',
    }
  }
  const lines = (result.stdout || '').split('\n').map(line => line.trim()).filter(Boolean)
  return {
    ok: lines.length > 1,
    port: 11435,
    ownership: 'remote-laptop',
    expectedService,
    controlPlane: 'laptop launchd is intentionally not inspectable from the iMac',
    inspectable: false,
    inspection: 'The laptop launchd owner is not inspectable from the iMac; the forwarded listener is authoritative.',
    recovery: 'laptop launchd KeepAlive should restart the reverse SSH tunnel',
    listeners: lines.slice(1),
    error: lines.length > 1 ? null : 'no listener on 127.0.0.1:11435'
  }
}

function remoteTunnelControlReport() {
  return {
    ok: true,
    skipped: true,
    remoteOwned: true,
    service: 'com.apizzamichigan.laptop-ollama-tunnel',
    controlPlane: 'laptop launchd is intentionally not inspectable from the iMac',
    inspection: 'The forwarded listener on 127.0.0.1:11435 is authoritative from the iMac.',
    recovery: 'laptop launchd KeepAlive should restart the reverse SSH tunnel'
  }
}

function queueReport(root, entity) {
  const dbPath = process.env.QUEUE_DB_PATH || join(root, 'scripts/.job-queue.db')
  if (!existsSync(dbPath)) return { ok: false, dbPath, error: 'queue DB not found' }

  let db
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })

    const totals = db.prepare(`
      SELECT
        COUNT(*) FILTER (WHERE job_type='classify' AND status='pending') as pending,
        COUNT(*) FILTER (WHERE job_type='classify' AND status='processing') as processing,
        COUNT(*) FILTER (WHERE job_type='classify' AND status='completed') as completed,
        COUNT(*) FILTER (WHERE job_type='classify' AND status='failed') as failed
      FROM jobs
      WHERE place_type = ?
    `).get(entity)

    const recent = db.prepare(`
      SELECT
        COUNT(*) FILTER (
          WHERE job_type='classify'
            AND status='completed'
            AND completed_at >= datetime('now', '-' || ? || ' hours')
        ) as completed,
        COUNT(*) FILTER (
          WHERE job_type='classify'
            AND status='failed'
            AND completed_at >= datetime('now', '-' || ? || ' hours')
        ) as failed
      FROM jobs
      WHERE place_type = ?
    `).get(WINDOW_HOURS, WINDOW_HOURS, entity)

    const processingJobs = db.prepare(`
      SELECT
        id,
        osm_id,
        worker_id,
        attempts,
        max_attempts,
        started_at,
        ROUND((julianday('now') - julianday(started_at)) * 24 * 60, 1) as minutes_processing,
        last_error
      FROM jobs
      WHERE job_type='classify'
        AND place_type = ?
        AND status='processing'
      ORDER BY started_at
      LIMIT ?
    `).all(entity, MAX_ROWS)

    const staleProcessingJobs = db.prepare(`
      SELECT
        id,
        osm_id,
        worker_id,
        attempts,
        max_attempts,
        started_at,
        ROUND((julianday('now') - julianday(started_at)) * 24 * 60, 1) as minutes_processing,
        last_error
      FROM jobs
      WHERE job_type='classify'
        AND place_type = ?
        AND status='processing'
        AND started_at < datetime('now', '-' || ? || ' minutes')
      ORDER BY started_at
      LIMIT ?
    `).all(entity, STALE_MINUTES, MAX_ROWS)

    const worker = db.prepare(`
      SELECT
        worker_id,
        agent_type,
        status,
        current_job_id,
        jobs_completed,
        jobs_failed,
        last_heartbeat,
        ROUND((julianday('now') - julianday(last_heartbeat)) * 24 * 60, 1) as minutes_since_heartbeat
      FROM workers
      WHERE worker_id = ?
    `).get(WORKER_ID)

    const workers = db.prepare(`
      SELECT worker_id, agent_type, status, current_job_id, jobs_completed,
             jobs_failed, last_heartbeat,
             ROUND((julianday('now') - julianday(last_heartbeat)) * 24 * 60, 1) as minutes_since_heartbeat
      FROM workers
      WHERE agent_type = 'classify'
      ORDER BY worker_id
    `).all()

    const staleWorkers = db.prepare(`
      SELECT
        worker_id,
        agent_type,
        status,
        current_job_id,
        last_heartbeat,
        ROUND((julianday('now') - julianday(last_heartbeat)) * 24 * 60, 1) as minutes_since_heartbeat
      FROM workers
      WHERE last_heartbeat < datetime('now', '-' || ? || ' minutes')
        AND (status != 'idle' OR current_job_id IS NOT NULL)
      ORDER BY last_heartbeat
      LIMIT ?
    `).all(STALE_MINUTES, MAX_ROWS)

    const recentCompleted = db.prepare(`
      SELECT id, osm_id, completed_at, last_error
      FROM jobs
      WHERE job_type='classify'
        AND place_type = ?
        AND status='completed'
        AND completed_at IS NOT NULL
      ORDER BY completed_at DESC
      LIMIT ?
    `).all(entity, MAX_ROWS)

    return {
      ok: true,
      dbPath,
      totals,
      recentWindowHours: WINDOW_HOURS,
      recent,
      processingJobs,
      staleProcessingJobs,
      worker: worker || null,
      workers,
      staleWorkers,
      recentCompleted
    }
  } catch (error) {
    return { ok: false, dbPath, error: errorMessage(error) }
  } finally {
    if (db) db.close()
  }
}

function operationalRegions(root, entity) {
  try {
    if (entity === 'pizza') {
      const config = JSON.parse(readFileSync(join(root, 'config/source-pipeline.json'), 'utf8'))
      return Array.isArray(config.operational_regions) ? config.operational_regions : []
    }
    const profiles = JSON.parse(readFileSync(join(root, 'config/entity-profiles.json'), 'utf8'))
    return Array.isArray(profiles.profiles?.[entity]?.regions) ? profiles.profiles[entity].regions : []
  } catch {
    return []
  }
}

function parseJobData(value) {
  if (!value) return {}
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

function classificationBacklogReport(root, rows, entity) {
  const dbPath = process.env.QUEUE_DB_PATH || join(root, 'scripts/.job-queue.db')
  const regions = operationalRegions(root, entity)
  const base = {
    ok: false,
    regions,
    candidates: rows.length,
    missingJob: 0,
    pending: 0,
    processing: 0,
    retryablePartial: 0,
    exhaustedPartial: 0,
    failed: 0,
    other: 0,
    recentCompleted: 0,
    recentWindowHours: WINDOW_HOURS,
  }
  if (!regions.length) return { ...base, error: 'no operational regions configured' }
  if (!existsSync(dbPath)) return { ...base, error: 'queue DB not found' }

  let db
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const jobs = new Map(db.prepare(`
      SELECT osm_id, status, data
      FROM jobs
      WHERE job_type = 'classify'
        AND place_type = ?
    `).all(entity).map(job => [job.osm_id, job]))

    const recentCompleted = db.prepare(`
      SELECT COUNT(*) as count
      FROM jobs
      WHERE job_type = 'classify'
        AND place_type = ?
        AND status = 'completed'
        AND completed_at >= datetime('now', '-' || ? || ' hours')
    `).get(entity, WINDOW_HOURS).count

    const counts = { ...base }
    for (const row of rows) {
      const job = jobs.get(row.google_place_id)
      if (!job) {
        counts.missingJob += 1
        continue
      }
      if (job.status === 'pending') counts.pending += 1
      else if (job.status === 'processing') counts.processing += 1
      else if (job.status === 'failed') counts.failed += 1
      else if (job.status === 'completed') {
        const retries = Number(parseJobData(job.data).partial_reprocess_count) || 0
        if (retries < 1) counts.retryablePartial += 1
        else counts.exhaustedPartial += 1
      } else counts.other += 1
    }
    return {
      ...counts,
      ok: true,
      dbPath,
      recentCompleted: Number(recentCompleted) || 0,
      recentWindowHours: WINDOW_HOURS,
      ...estimateClassificationBacklog({
        candidates: counts.candidates,
        completedLastWindow: recentCompleted,
        windowHours: WINDOW_HOURS,
      }),
      ...summarizeClassificationBacklog({ ...counts, ok: true }),
    }
  } catch (error) {
    return { ...base, dbPath, error: errorMessage(error) }
  } finally {
    if (db) db.close()
  }
}

async function postgresReport(root, profile) {
  const client = new pg.Client({
    host: process.env.PGHOST || 'localhost',
    port: process.env.PGPORT ? Number.parseInt(process.env.PGPORT, 10) : 5432,
    database: process.env.PGDATABASE || 'pizza_enrichment',
    user: process.env.PGUSER || process.env.USER,
    password: process.env.PGPASSWORD || ''
  })

  try {
    await client.connect()
    const summary = await client.query(`
      SELECT
        COUNT(*)::int as total,
        COUNT(*) FILTER (WHERE style IS NOT NULL OR price_range IS NOT NULL OR style_confidence IS NOT NULL)::int as classified_or_priced,
        COUNT(*) FILTER (WHERE style IS NULL AND price_range IS NULL AND style_confidence IS NULL)::int as missing_all_classification,
        COUNT(*) FILTER (WHERE style IS NULL OR price_range IS NULL)::int as incomplete_classification,
        COUNT(*) FILTER (WHERE last_enriched_at >= now() - ($1::text || ' hours')::interval)::int as enriched_in_window,
        MAX(last_enriched_at) as last_enriched_at
      FROM ${profile.table}
    `, [String(WINDOW_HOURS)])
    const recent = await client.query(`
      SELECT id, name, state, google_place_id, style, price_range, style_confidence, last_enriched_at
      FROM ${profile.table}
      WHERE last_enriched_at IS NOT NULL
      ORDER BY last_enriched_at DESC
      LIMIT $1
    `, [MAX_ROWS])

    const regions = operationalRegions(root, profile.entity)
    const candidates = regions.length
      ? await client.query(`
          SELECT google_place_id
          FROM ${profile.table}
          WHERE state = ANY($1::text[])
            AND NULLIF(BTRIM(google_place_id), '') IS NOT NULL
            AND (
              scrape_method IN ('fetch', 'browser')
              OR osm_tags IS NOT NULL
              OR EXISTS (
                SELECT 1
                FROM place_sources ps
                WHERE ps.entity_type = $2
                  AND ps.place_id = ${profile.table}.id
                  AND ps.match_confidence >= 0.9
              )
            )
            AND (style IS NULL OR price_range IS NULL)
        `, [regions, profile.entity])
      : { rows: [] }

    return {
      ok: true,
      summary: summary.rows[0],
      recent: recent.rows,
      classificationBacklog: classificationBacklogReport(root, candidates.rows, profile.entity)
    }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  } finally {
    await client.end().catch(() => {})
  }
}

async function ollamaReport() {
  const configuredUrl = process.env.CLASSIFIER_OLLAMA_URL || process.env.OLLAMA_URL
  const baseUrl = configuredUrl === 'http://localhost:11434' || configuredUrl === 'http://127.0.0.1:11434'
    ? 'http://127.0.0.1:11435'
    : (configuredUrl || 'http://127.0.0.1:11435')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3000)
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal })
    if (!res.ok) return { ok: false, baseUrl, error: `HTTP ${res.status}` }
    const data = await res.json()
    const models = (data.models || []).map(model => model.name).sort()
    return { ok: true, baseUrl, models }
  } catch (error) {
    return { ok: false, baseUrl, error: error.name === 'AbortError' ? 'timeout' : errorMessage(error) }
  } finally {
    clearTimeout(timeout)
  }
}

function classifyHealth({ git, launchd, tunnelLaunchd, processes, queue, postgres, ollama, tunnel }) {
  const issues = []
  const warnings = []

  if (!git.clean) warnings.push('repo has local changes')
  if (git.head !== git.originMain) warnings.push(`HEAD (${git.head}) differs from origin/main (${git.originMain})`)

  if (!launchd.skipped && !launchd.ok) issues.push(`launchd service is not running: ${launchd.error || launchd.state}`)
  if (!tunnelLaunchd.skipped && tunnelLaunchd.ok === false && !tunnel.ok) {
    issues.push(`laptop Ollama tunnel is unavailable: ${tunnelLaunchd.error || tunnelLaunchd.state}`)
  }
  if (!processes.ok) warnings.push(`process scan failed: ${processes.error}`)
  else {
    if (processes.classifier.length !== EXPECTED_CLASSIFIER_PROCESSES) issues.push(`expected exactly ${EXPECTED_CLASSIFIER_PROCESSES} classifier processes, found ${processes.classifier.length}`)
    if (processes.scraper.length !== EXPECTED_SCRAPER_PROCESSES) warnings.push(`expected ${EXPECTED_SCRAPER_PROCESSES} managed scraper process${EXPECTED_SCRAPER_PROCESSES === 1 ? '' : 'es'}, found ${processes.scraper.length}`)
    if (processes.unexpected.length) issues.push(`unexpected enrichment processes found: ${processes.unexpected.length}`)
  }

  if (!queue.ok) issues.push(`queue unavailable: ${queue.error}`)
  else {
    if (queue.totals.processing > EXPECTED_CLASSIFIER_PROCESSES) issues.push(`too many classify jobs processing: ${queue.totals.processing}`)
    if (queue.staleProcessingJobs.length) issues.push(`stale classify processing jobs: ${queue.staleProcessingJobs.length}`)
    if (queue.staleWorkers.length) issues.push(`stale worker rows: ${queue.staleWorkers.length}`)
    if (!queue.worker) issues.push(`worker row ${WORKER_ID} is missing`)
    else if (queue.worker.minutes_since_heartbeat > STALE_MINUTES) issues.push(`worker heartbeat is stale: ${queue.worker.minutes_since_heartbeat}m`)
    if (queue.workers && queue.workers.length < EXPECTED_CLASSIFIER_PROCESSES) issues.push(`expected ${EXPECTED_CLASSIFIER_PROCESSES} classify worker rows, found ${queue.workers.length}`)
    if (queue.recent.completed === 0 && queue.totals.pending > IDLE_WARNING_MINIMUM) {
      warnings.push(`no classify completions in last ${WINDOW_HOURS}h while ${queue.totals.pending} jobs remain pending`)
    }
  }

  if (!postgres.ok) issues.push(`Postgres unavailable: ${postgres.error}`)
  else {
    const backlog = postgres.classificationBacklog
    if (backlog?.ok) {
      if (backlog.missingJob > 0) {
        issues.push(`${backlog.missingJob} classification candidates have no queue job`)
      }
      if (backlog.retryablePartial > 0) {
        warnings.push(`${backlog.retryablePartial} classification candidates are waiting for bounded partial-result retry`)
      }
      if (backlog.exhaustedPartial > 0) {
        warnings.push(`${backlog.exhaustedPartial} classification candidates exhausted automatic retry and need review`)
      }
    }
    if (postgres.summary.enriched_in_window === 0 && queue.ok && queue.totals.pending > IDLE_WARNING_MINIMUM) {
      warnings.push(`no Postgres enrichment writes in last ${WINDOW_HOURS}h`)
    }
  }

  if (!ollama.ok) issues.push(`Ollama unavailable: ${ollama.error}`)
  if (!tunnel.ok) issues.push(`Ollama tunnel unavailable: ${tunnel.error}`)

  const state = issues.length ? 'FAIL' : warnings.length ? 'WARN' : 'OK'
  return { state, issues, warnings }
}

function table(headers, rows) {
  if (!rows.length) return '_none_'
  const escape = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const head = `| ${headers.join(' | ')} |`
  const sep = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map(row => `| ${headers.map(header => escape(row[header])).join(' | ')} |`)
  return [head, sep, ...body].join('\n')
}

function list(items) {
  return items.length ? items.map(item => `- ${item}`).join('\n') : '- none'
}

function processList(rows) {
  return rows.length ? rows.map(row => `- \`${row}\``).join('\n') : '- none'
}

async function main() {
  const root = repoRoot()
  const generatedAt = new Date().toISOString()
  const git = gitReport(root)
  const launchd = launchdReport()
  // The tunnel is owned by launchd on the laptop, not this iMac. Calling
  // launchctl here produces a false failure even when the forwarded listener
  // is healthy, so the listener remains the authoritative remote check.
  const tunnelLaunchd = remoteTunnelControlReport()
  const processes = processReport()
  const tunnel = tunnelReport()
  const queue = queueReport(root, ENTITY_PROFILE.entity)
  const [postgres, ollama] = await Promise.all([postgresReport(root, ENTITY_PROFILE), ollamaReport()])
  const health = classifyHealth({ git, launchd, tunnelLaunchd, processes, queue, postgres, ollama, tunnel })

  const payload = {
    generatedAt,
    root,
    entity: ENTITY_PROFILE.entity,
    canonicalTable: ENTITY_PROFILE.table,
    health,
    git,
    launchd,
    tunnelLaunchd,
    processes,
    tunnel,
    queue,
    postgres,
    ollama,
  }
  if (args.has('--json')) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  console.log(`# ${ENTITY_PROFILE.entity} classifier health: ${health.state}`)
  console.log('')
  console.log(`Generated: ${generatedAt}`)
  console.log(`Repo: \`${root}\``)
  console.log(`Tunnel: ${tunnel.ok ? `ok (127.0.0.1:${tunnel.port})` : `failed (${tunnel.error})`}`)
  console.log('')

  console.log('## Summary')
  console.log(`- state: ${health.state}`)
  console.log(`- branch/head: \`${git.branch}\` / \`${git.head}\``)
  console.log(`- origin/main: \`${git.originMain}\``)
  if (launchd.skipped) console.log(`- launchd: skipped (${launchd.reason})`)
  else console.log(`- launchd: ${launchd.state || 'unknown'}${launchd.pid ? ` pid=${launchd.pid}` : ''}`)
  if (queue.ok) {
    console.log(`- classify queue: pending=${queue.totals.pending}, processing=${queue.totals.processing}, completed=${queue.totals.completed}, failed=${queue.totals.failed}`)
    console.log(`- last ${queue.recentWindowHours}h: completed=${queue.recent.completed}, failed=${queue.recent.failed}`)
  } else {
    console.log(`- classify queue: unavailable (${queue.error})`)
  }
  if (postgres.ok) {
    console.log(`- Postgres writes last ${WINDOW_HOURS}h: ${postgres.summary.enriched_in_window}`)
    console.log(`- classified_or_priced: ${postgres.summary.classified_or_priced}`)
    console.log(`- missing_all_classification: ${postgres.summary.missing_all_classification}`)
    console.log(`- incomplete_classification: ${postgres.summary.incomplete_classification}`)
    if (postgres.classificationBacklog?.ok) {
      const backlog = postgres.classificationBacklog
      console.log(`- operational classification backlog (${backlog.regions.join(', ')}): ${backlog.candidates}`)
      console.log(`- backlog queue state: pending=${backlog.pending}, processing=${backlog.processing}, retryable_partial=${backlog.retryablePartial}, missing_job=${backlog.missingJob}, exhausted_partial=${backlog.exhaustedPartial}`)
      console.log(`- backlog meaning: ${backlog.state} — ${backlog.recommendedAction}`)
      const throughput = Number(backlog.throughputPerHour) || 0
      const eta = backlog.estimatedDays === null
        ? 'unavailable'
        : `${backlog.estimatedDays.toFixed(1)} days`
      console.log(`- backlog throughput: ${throughput.toFixed(1)} completed/hour (${backlog.estimateBasis || 'no observation window'})`)
      console.log(`- backlog ETA: ${eta}`)
    } else if (postgres.classificationBacklog) {
      console.log(`- operational classification backlog: unavailable (${postgres.classificationBacklog.error})`)
    }
    console.log(`- last_enriched_at: ${postgres.summary.last_enriched_at || ''}`)
  } else {
    console.log(`- Postgres: unavailable (${postgres.error})`)
  }
  console.log(`- Ollama: ${ollama.ok ? `ok (${ollama.models.join(', ') || 'no models'})` : `failed (${ollama.error})`}`)
  console.log(`- Ollama tunnel control: ${tunnel.ok ? `healthy remote listener; recovery=${tunnel.recovery}` : tunnelLaunchd.ok ? `running (${tunnelLaunchd.service})` : `unavailable (${tunnelLaunchd.error || tunnelLaunchd.state}); expected=${tunnel.expectedService || 'unknown'}`}`)
  console.log('')

  console.log('## Issues')
  console.log(list(health.issues))
  console.log('')
  console.log('## Warnings')
  console.log(list(health.warnings))
  console.log('')

  if (queue.ok) {
    console.log('## Active Classify Job')
    console.log(table(['id', 'osm_id', 'worker_id', 'attempts', 'max_attempts', 'started_at', 'minutes_processing', 'last_error'], queue.processingJobs))
    console.log('')
    console.log('## Classifier Worker')
    console.log(table(['worker_id', 'agent_type', 'status', 'current_job_id', 'jobs_completed', 'jobs_failed', 'last_heartbeat', 'minutes_since_heartbeat'], queue.worker ? [queue.worker] : []))
    console.log('')
    console.log('## Recent Completed Classify Jobs')
    console.log(table(['id', 'osm_id', 'completed_at', 'last_error'], queue.recentCompleted))
    console.log('')
  }

  if (postgres.ok) {
    console.log('## Recent Postgres Writes')
    console.log(table(['id', 'name', 'state', 'google_place_id', 'style', 'price_range', 'style_confidence', 'last_enriched_at'], postgres.recent))
    console.log('')
  }

  if (processes.ok) {
    console.log('## Classifier Processes')
    console.log(processList(processes.classifier))
    console.log('')
    console.log('## Managed Scraper Processes')
    console.log(processList(processes.scraper))
    console.log('')
    console.log('## Unexpected Enrichment Processes')
    console.log(processList(processes.unexpected))
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
