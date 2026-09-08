#!/usr/bin/env node
/**
 * Bounded deterministic menu parser.
 *
 * This worker is intentionally independent of the classifier and Ollama. It
 * consumes only menu_parse jobs and exits after --max-jobs so operators can
 * smoke-test it before scheduling any larger slowlane run.
 */

import pg from 'pg'
import { getQueue } from '../queue.mjs'
import { extractMenuData } from '../../lib/menu-data-extractor.mjs'

const maxJobsArg = process.argv.indexOf('--max-jobs')
const maxJobs = Number.parseInt(maxJobsArg >= 0 ? process.argv[maxJobsArg + 1] : process.env.MENU_PARSE_MAX_JOBS || '1', 10)
const workerId = process.env.MENU_PARSE_WORKER_ID || `menu-parse-${Date.now()}`
const placeTable = placeType => placeType === 'pizza' ? 'pizza_places' : 'taco_places'

if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 100) {
  throw new Error('Use --max-jobs between 1 and 100.')
}

function dbClient() {
  return new pg.Client({
    host: process.env.PGHOST || 'localhost',
    port: Number.parseInt(process.env.PGPORT || '5432', 10),
    database: process.env.PGDATABASE || 'pizza_enrichment',
    user: process.env.PGUSER || process.env.USER,
    password: process.env.PGPASSWORD || '',
  })
}

async function processJob(queue, client, job) {
  const table = placeTable(job.placeType)
  const result = await client.query(`
    SELECT id, name, website_url, scrape_notes, menu_data
    FROM ${table}
    WHERE google_place_id = $1
    LIMIT 1
  `, [job.osmId])
  const place = result.rows[0]

  if (!place) {
    queue.complete(job.id, { skipped: 'place_missing' })
    return 'place_missing'
  }
  if (place.menu_data) {
    queue.complete(job.id, { skipped: 'already_has_menu_data' })
    return 'already_has_menu_data'
  }

  const menuData = extractMenuData(place.scrape_notes, { websiteUrl: place.website_url })
  if (!menuData) {
    await client.query(`
      UPDATE ${table}
      SET menu_parse_confidence = 'none',
          menu_parse_notes = 'deterministic_parser: no structured menu evidence',
          menu_last_parsed_at = NOW()
      WHERE id = $1
    `, [place.id])
    queue.complete(job.id, { skipped: 'no_structured_menu_evidence' })
    return 'no_structured_menu_evidence'
  }

  await client.query(`
    UPDATE ${table}
    SET menu_data = COALESCE($2::jsonb, menu_data),
        menu_parse_confidence = $3,
        menu_parse_notes = $4,
        menu_last_parsed_at = NOW(),
        last_enriched_at = NOW()
    WHERE id = $1
  `, [place.id, JSON.stringify(menuData), menuData.confidence, `deterministic_parser: ${menuData.extraction_method}`])
  queue.complete(job.id, { ok: true, confidence: menuData.confidence, method: menuData.extraction_method })
  return menuData.extraction_method
}

async function main() {
  const queue = getQueue()
  const client = dbClient()
  let completed = 0
  try {
    await client.connect()
    console.log(`[${workerId}] Deterministic menu parser started (max-jobs=${maxJobs})`)
    while (completed < maxJobs) {
      const job = queue.claim('menu_parse', workerId)
      if (!job) break
      try {
        const outcome = await processJob(queue, client, job)
        console.log(`[${workerId}] Completed menu job ${job.id}: ${outcome}`)
      } catch (error) {
        queue.fail(job.id, error.message || String(error))
        console.error(`[${workerId}] Failed menu job ${job.id}: ${error.message || error}`)
      }
      completed += 1
    }
    console.log(`[${workerId}] Deterministic menu parser stopped after ${completed} job(s)`)
  } finally {
    await client.end().catch(() => {})
    queue.close()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
