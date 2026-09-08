#!/usr/bin/env node
/**
 * Populate scrape jobs from local Postgres.
 *
 * Creates `scrape` jobs in the SQLite queue for places that already have a website_url
 * and have not been scraped yet.
 *
 * Default: pizza only.
 *
 * Usage:
 *   node scripts/enrichment/populate-scrape-from-db.mjs
 *   node scripts/enrichment/populate-scrape-from-db.mjs --type pizza|taco
 *   node scripts/enrichment/populate-scrape-from-db.mjs --state MI
 *   node scripts/enrichment/populate-scrape-from-db.mjs --ids 181254,181255
 *   node scripts/enrichment/populate-scrape-from-db.mjs --id-prefix all_the_places:
 *   node scripts/enrichment/populate-scrape-from-db.mjs --min-place-id 181254 --max-place-id 181347
 *   node scripts/enrichment/populate-scrape-from-db.mjs --priority-boost 100000
 *   node scripts/enrichment/populate-scrape-from-db.mjs --limit 5000
 *   node scripts/enrichment/populate-scrape-from-db.mjs --dry-run
 */

import pg from 'pg'
import 'dotenv/config'
import { getQueue } from './queue.mjs'
import { calculatePriority } from './priority.mjs'

function parseArgs() {
  const args = process.argv.slice(2)
  const help = args.includes('--help') || args.includes('-h')
  const dryRun = args.includes('--dry-run')
  const type = args.includes('--type') ? args[args.indexOf('--type') + 1] : 'pizza'
  const ids = args.includes('--ids')
    ? args[args.indexOf('--ids') + 1].split(',').map((value) => parseInt(value.trim(), 10)).filter(Number.isFinite)
    : []
  const state = args.includes('--state') ? args[args.indexOf('--state') + 1] : null
  const idPrefix = args.includes('--id-prefix') ? args[args.indexOf('--id-prefix') + 1] : 'osm:'
  const minPlaceId = args.includes('--min-place-id') ? parseInt(args[args.indexOf('--min-place-id') + 1], 10) : null
  const maxPlaceId = args.includes('--max-place-id') ? parseInt(args[args.indexOf('--max-place-id') + 1], 10) : null
  const priorityBoost = args.includes('--priority-boost') ? parseInt(args[args.indexOf('--priority-boost') + 1], 10) : 0
  const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1], 10) : null
  return { help, dryRun, type, ids, state, idPrefix, minPlaceId, maxPlaceId, priorityBoost, limit }
}

function printHelp() {
  console.log(`Usage: node scripts/enrichment/populate-scrape-from-db.mjs [options]

Options:
  --type <pizza|taco>       Place table family (default pizza)
  --state <code>            Optional state filter
  --ids <ids>               Exact comma-separated local place ids
  --id-prefix <prefix|*>    Canonical id prefix filter (default osm:)
  --min-place-id <id>       Minimum local place id
  --max-place-id <id>       Maximum local place id
  --priority-boost <n>      Boost matching pending scrape jobs after add
  --limit <n>               Maximum candidates to inspect
  --dry-run                 Count candidates without adding or boosting jobs
  --help                    Print this help and exit

Default mode writes scrape jobs to the local SQLite queue. Use --dry-run before
broad queue population.
`)
}

async function main() {
  const { help, dryRun, type, ids, state, idPrefix, minPlaceId, maxPlaceId, priorityBoost, limit } = parseArgs()
  if (help) {
    printHelp()
    return
  }
  const table = type === 'taco' ? 'taco_places' : 'pizza_places'

  const client = new pg.Client({
    host: process.env.PGHOST || 'localhost',
    port: process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : 5432,
    database: process.env.PGDATABASE || 'pizza_enrichment',
    user: process.env.PGUSER || process.env.USER,
    password: process.env.PGPASSWORD || ''
  })

  await client.connect()
  const queue = dryRun ? null : getQueue()

  const clauses = [
    'website_url IS NOT NULL',
    "(scrape_method IS NULL OR scrape_method NOT IN ('fetch', 'browser'))"
  ]
  const params = []

  if (ids.length) {
    params.push(ids)
    clauses.push(`id = ANY($${params.length}::int[])`)
  } else if (idPrefix && idPrefix !== '*') {
    params.push(`${idPrefix}%`)
    clauses.push(`google_place_id LIKE $${params.length}`)
  }

  if (state) {
    params.push(state)
    clauses.push(`state = $${params.length}`)
  }

  if (Number.isFinite(minPlaceId)) {
    params.push(minPlaceId)
    clauses.push(`id >= $${params.length}`)
  }

  if (Number.isFinite(maxPlaceId)) {
    params.push(maxPlaceId)
    clauses.push(`id <= $${params.length}`)
  }

  let limitSql = ''
  if (limit && Number.isFinite(limit)) {
    params.push(limit)
    limitSql = `LIMIT $${params.length}`
  }

  const sql = `
    SELECT id, google_place_id, state
    FROM ${table}
    WHERE ${clauses.join(' AND ')}
    ORDER BY state = 'MI' DESC, id ASC
    ${limitSql}
  `

  const res = await client.query(sql, params)

  const jobs = res.rows.map((row) => ({
    jobType: 'scrape',
    osmId: row.google_place_id,
    placeType: type,
    priority: calculatePriority(row.state),
    data: { state: row.state }
  }))

  const added = dryRun ? 0 : queue.addJobs(jobs)
  let boosted = 0

  if (!dryRun && Number.isFinite(priorityBoost) && priorityBoost > 0 && jobs.length) {
    const stmt = queue.db.prepare(`
      UPDATE jobs
      SET priority = ?
      WHERE job_type = 'scrape'
        AND osm_id = ?
        AND status = 'pending'
        AND priority < ?
    `)
    const boostJobs = queue.db.transaction((rows) => {
      let changes = 0
      for (const job of rows) {
        const boostedPriority = (job.priority ?? calculatePriority(job.data?.state)) + priorityBoost
        const result = stmt.run(boostedPriority, job.osmId, boostedPriority)
        changes += result.changes
      }
      return changes
    })
    boosted = boostJobs(jobs)
  }

  console.log(`Found ${res.rowCount} candidates in ${table}`)
  console.log(`Mode: ${dryRun ? 'dry-run' : 'apply'}`)
  console.log(`Added ${added} scrape jobs to SQLite queue`)
  if (priorityBoost > 0) console.log(`Boosted ${boosted} pending scrape jobs by ${priorityBoost}`)

  queue?.close()
  await client.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
