#!/usr/bin/env node
/**
 * LLM Classifier Agent (local-only)
 *
 * Claims `classify` jobs from the SQLite queue and writes structured fields
 * back into local Postgres.
 *
 * Guardrails:
 * - Deterministic chain overrides first (style-inference.mjs)
 * - Otherwise, call Ollama with strict JSON output
 * - Only write values that match the known taxonomy
 * - Prefer null over guessing
 */

import { getQueue } from '../queue.mjs'
import pg from 'pg'
import 'dotenv/config'
import { withHostCompute } from '@map-pipeline/executor/host-resource-gate'
import { inferStyleFromName, inferStyleFromBrandWikidata, inferPriceFromChain } from '../../lib/style-inference.mjs'
import { hasStyleEvidence } from '../../lib/style-evidence.mjs'
import { PIZZA_STYLES, normalizePizzaStyle } from '../../lib/pizza-style-taxonomy.mjs'
import { enrichmentEntity, normalizeEnrichmentStyle } from '../../lib/enrichment-entity.mjs'
import { inferTypeFromName, inferPriceFromChain as inferTacoPrice, isKnownChain as isKnownTacoChain, formatTypesForStorage } from '../../lib/type-inference-tacos.mjs'

const PRICE_RANGES = ['$', '$$', '$$$', '$$$$']

const MODEL = process.env.OLLAMA_MODEL || 'llama3.2:latest'
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434'
const OLLAMA_TIMEOUT_MS = process.env.OLLAMA_TIMEOUT_MS ? parseInt(process.env.OLLAMA_TIMEOUT_MS, 10) : 300000

// Performance tuning: cap per-request threads.
// Ollama supports passing "options" in /api/generate.
// On 4-core machines: 4 threads allows full utilization per request while leaving room for OS/other workers.
const OLLAMA_NUM_THREADS = process.env.OLLAMA_NUM_THREADS ? parseInt(process.env.OLLAMA_NUM_THREADS, 10) : 4
const OLLAMA_NUM_PREDICT = process.env.OLLAMA_NUM_PREDICT ? parseInt(process.env.OLLAMA_NUM_PREDICT, 10) : 120
const OLLAMA_TEMPERATURE = process.env.OLLAMA_TEMPERATURE ? Number(process.env.OLLAMA_TEMPERATURE) : 0

const OLLAMA_HEALTHCHECK_INTERVAL_MS = process.env.OLLAMA_HEALTHCHECK_INTERVAL_MS
  ? parseInt(process.env.OLLAMA_HEALTHCHECK_INTERVAL_MS, 10)
  : 30000
const OLLAMA_HEALTHCHECK_TIMEOUT_MS = process.env.OLLAMA_HEALTHCHECK_TIMEOUT_MS
  ? parseInt(process.env.OLLAMA_HEALTHCHECK_TIMEOUT_MS, 10)
  : 10000

const OSM_TAG_KEYS = [
  'amenity',
  'brand',
  'brand:wikidata',
  'cuisine',
  'name',
  'operator',
  'operator:wikidata',
  'website',
  'contact:website',
  'phone',
  'contact:phone',
  'addr:city',
  'addr:state',
  'addr:country'
]

function safeJsonParse(text) {
  try {
    return JSON.parse(text)
  } catch {}
  const m = text?.match(/\{[\s\S]*\}/)
  if (m) {
    try { return JSON.parse(m[0]) } catch {}
  }
  return null
}

function normalizeStyle(style, entity = 'pizza') {
  return entity === 'pizza' ? normalizePizzaStyle(style) : normalizeEnrichmentStyle(style, entity)
}

function normalizePrice(price) {
  if (!price) return null
  const p = String(price).trim()
  return PRICE_RANGES.includes(p) ? p : null
}

async function ollamaGenerate(prompt, { onController } = {}) {
  const controller = new AbortController()
  if (typeof onController === 'function') onController(controller)
  let timeout

  try {
    return await withHostCompute(async () => {
    timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS)
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        prompt,
        stream: false,
        format: 'json',
        options: {
          num_thread: Number.isFinite(OLLAMA_NUM_THREADS) && OLLAMA_NUM_THREADS > 0 ? OLLAMA_NUM_THREADS : 2,
          num_predict: Number.isFinite(OLLAMA_NUM_PREDICT) && OLLAMA_NUM_PREDICT > 0 ? OLLAMA_NUM_PREDICT : 120,
          temperature: Number.isFinite(OLLAMA_TEMPERATURE) ? OLLAMA_TEMPERATURE : 0
        }
      }),
      signal: controller.signal
    })

    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(`ollama HTTP ${res.status}: ${t.slice(0, 200)}`)
    }

    const data = await res.json()
    return data.response
    }, { signal: controller.signal })
  } catch (err) {
    clearTimeout(timeout)
    if (err.name === 'AbortError') {
      const secs = Math.round(OLLAMA_TIMEOUT_MS / 1000)
      throw new Error(`Ollama request timeout (${secs}s)`)
    }
    throw err
  } finally {
    clearTimeout(timeout)
    if (typeof onController === 'function') onController(null)
  }
}

async function ollamaIsHealthy() {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), OLLAMA_HEALTHCHECK_TIMEOUT_MS)
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: controller.signal })
    if (!res.ok) return { ok: false, error: `ollama HTTP ${res.status}` }
    return { ok: true, error: null }
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, error: 'ollama healthcheck timeout' }
    return { ok: false, error: err.message || String(err) }
  } finally {
    clearTimeout(timeout)
  }
}

function truncateText(value, maxChars = 1000) {
  if (value === null || value === undefined) return value
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text
}

function pruneOsmTags(tags) {
  if (!tags || typeof tags !== 'object') return {}
  return OSM_TAG_KEYS.reduce((acc, key) => {
    if (tags[key] !== null && tags[key] !== undefined && tags[key] !== '') {
      acc[key] = truncateText(tags[key], 300)
    }
    return acc
  }, {})
}

function pruneJsonLdEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry
  const address = entry.address && typeof entry.address === 'object'
    ? {
        streetAddress: entry.address.streetAddress,
        addressLocality: entry.address.addressLocality,
        addressRegion: entry.address.addressRegion,
        addressCountry: entry.address.addressCountry,
      }
    : undefined

  return {
    '@type': entry['@type'],
    name: entry.name,
    description: truncateText(entry.description, 500),
    servesCuisine: entry.servesCuisine,
    priceRange: entry.priceRange,
    telephone: entry.telephone,
    url: entry.url,
    menu: entry.menu,
    address,
  }
}

function pruneJsonLd(jsonld) {
  if (!jsonld) return null
  const entries = Array.isArray(jsonld) ? jsonld : [jsonld]
  return entries
    .slice(0, 3)
    .map(pruneJsonLdEntry)
    .filter(Boolean)
}

function parseScrapeNotes(scrapeNotes) {
  if (!scrapeNotes) return {}
  if (typeof scrapeNotes !== 'string') return scrapeNotes
  try {
    return JSON.parse(scrapeNotes)
  } catch {
    return { text_excerpt: scrapeNotes }
  }
}

function buildPrompt(row, entity = 'pizza') {
  const osmTags = row.osm_tags ? JSON.stringify(pruneOsmTags(row.osm_tags)) : ''
  const sourceEvidence = row.source_evidence?.length
    ? truncateText(JSON.stringify(row.source_evidence), 1800)
    : ''

  // Build a pruned scrape_notes: prioritize JSON-LD, include text_excerpt only if needed
  let scrapeData = {}
  if (row.scrape_notes) {
    const notes = parseScrapeNotes(row.scrape_notes)

    // Always include jsonld if present (high signal)
    if (notes.jsonld) scrapeData.jsonld = pruneJsonLd(notes.jsonld)

    // Include other hints (small)
    if (notes.style_hints) scrapeData.style_hints = Array.isArray(notes.style_hints)
      ? notes.style_hints.slice(0, 15).map(hint => truncateText(hint, 120))
      : truncateText(notes.style_hints, 500)
    if (notes.price_hint) scrapeData.price_hint = truncateText(notes.price_hint, 120)
    if (notes.menu_url) scrapeData.menu_url = truncateText(notes.menu_url, 300)

    // Only include text_excerpt if we have little other signal (keep prompt small)
    const hasSignal = Boolean(scrapeData.jsonld?.length || scrapeData.style_hints)
    if (!hasSignal && notes.text_excerpt) {
      scrapeData.text_excerpt = truncateText(notes.text_excerpt, 1200)
    }
  }

  const scrapeNotes = Object.keys(scrapeData).length ? truncateText(JSON.stringify(scrapeData), 2500) : ''

  const profile = enrichmentEntity(entity)
  return `You are classifying a restaurant into a fixed ${profile.taxonomyLabel} taxonomy.\n\nReturn ONLY valid JSON with this schema:\n{\n  \"style\": string|null,\n  \"price_range\": \"$\"|\"$$\"|\"$$$\"|\"$$$$\"|null,\n  \"style_confidence\": \"confirmed\"|\"inferred\"\n}\n\nRules:\n- style must be exactly one of: ${profile.taxonomy.map(s => `\"${s}\"`).join(', ')}\n- If unsure, use null for style and/or price_range (do not guess).\n- Use style_confidence=confirmed only if the source explicitly states the type/style. Otherwise inferred.\n- Prefer high-signal evidence first: JSON-LD structured data, accepted source evidence, then style hints and text excerpts.\n\nRestaurant:\n- name: ${row.name}\n- state: ${row.state || ''}\n- website_url: ${row.website_url || ''}\n\nOSM tags (subset):\n${osmTags}\n\nAccepted source evidence:\n${sourceEvidence}\n\nScrape hints (prioritized):\n${scrapeNotes}\n`
}

class LlmClassifier {
  constructor(workerId, { maxJobs = 0 } = {}) {
    this.workerId = workerId
    this.queue = getQueue()
    this.pgClient = null
    this.running = false
    this.stopping = false
    this.currentJob = null
    this.activeOllamaController = null
    this.maxJobs = maxJobs
    this.stats = { completed: 0, failed: 0, overridden: 0, retried: 0 }

    this.ollamaHealth = {
      ok: false,
      lastCheckedAt: 0,
      lastError: null
    }
  }

  async init() {
    this.pgClient = new pg.Client({
      host: process.env.PGHOST || 'localhost',
      port: process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : 5432,
      database: process.env.PGDATABASE || 'pizza_enrichment',
      user: process.env.PGUSER || process.env.USER,
      password: process.env.PGPASSWORD || ''
    })

    await this.pgClient.connect()
    this.queue.registerWorker(this.workerId, 'classify')
  }

  async shutdown() {
    this.running = false
    this.stopping = true
    if (this.activeOllamaController) {
      this.activeOllamaController.abort()
      this.activeOllamaController = null
    }
    this.queue.unregisterWorker(this.workerId)
    this.queue.close()
    if (this.pgClient) await this.pgClient.end()
  }

  requestShutdown(signal = 'shutdown') {
    if (this.stopping) return
    console.log(`[${this.workerId}] ${signal} received; stopping after current operation`)
    this.running = false
    this.stopping = true
    if (this.activeOllamaController) {
      this.activeOllamaController.abort()
    }
  }

  sendStats(status = 'running') {
    if (!process.send) return
    process.send({
      type: 'stats',
      stats: {
        status,
        completed: this.stats.completed,
        failed: this.stats.failed,
        retried: this.stats.retried
      }
    })
  }

  async updateCanonicalRow(id, entity, patch) {
    // Keep the canonical classification contract intact even when an upstream
    // result omits confidence: a written style must always carry provenance.
    if (patch.style && !patch.style_confidence) {
      patch = { ...patch, style_confidence: 'inferred' }
    }

    const cols = []
    const vals = [id]
    let i = 2
    for (const [k, v] of Object.entries(patch)) {
      cols.push(`${k} = $${i}`)
      vals.push(v)
      i++
    }

    if (!cols.length) return

    await this.pgClient.query(
      `UPDATE ${enrichmentEntity(entity).table} SET ${cols.join(', ')}, last_enriched_at = NOW() WHERE id = $1`,
      vals
    )
  }

  async processJob(job) {
    const entity = job.placeType || 'pizza'
    const profile = enrichmentEntity(entity)
    const { rows } = await this.pgClient.query(
      `SELECT id, name, state, website_url, osm_tags, scrape_notes, scrape_method,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'source', ps.source,
                  'confidence', ps.match_confidence,
                  'data', ps.data
                ) ORDER BY ps.match_confidence DESC NULLS LAST, ps.retrieved_at DESC)
                FROM place_sources ps
                WHERE ps.entity_type = $2 AND ps.place_id = ${profile.table}.id
              ), '[]'::jsonb) AS source_evidence
       FROM ${profile.table}
       WHERE google_place_id = $1
       LIMIT 1`,
      [job.osmId, entity]
    )

    const row = rows[0]
    if (!row) {
      this.queue.fail(job.id, 'No matching local row')
      this.stats.failed++
      return
    }

    // Chain override layer
    const tacoInference = entity === 'taco' ? inferTypeFromName(row.name, row.address || '') : null
    const nameStyle = entity === 'taco' ? { style: formatTypesForStorage(tacoInference?.types) } : inferStyleFromName(row.name, '')
    const brandStyle = entity === 'pizza'
      ? inferStyleFromBrandWikidata(row.osm_tags?.['brand:wikidata'] || row.osm_tags?.['operator:wikidata'])
      : null
    const chainStyle = brandStyle?.style ? brandStyle : nameStyle
    const chainPrice = entity === 'taco' ? inferTacoPrice(row.name) : inferPriceFromChain(row.name)

    // A brand identifier is useful evidence for the LLM, but it is not itself a
    // classification. Only bypass inference when the deterministic catalog has
    // an actual style or price answer to apply.
    const hasDeterministicOverride = entity === 'taco'
      ? isKnownTacoChain(row.name)
      : Boolean(chainStyle?.style || chainPrice?.price)

    if (hasDeterministicOverride) {
      const style = chainStyle?.style || null
      const priceRange = chainPrice?.price || null

      await this.updateCanonicalRow(row.id, entity, {
        style,
        price_range: priceRange,
        style_confidence: style ? 'confirmed' : null
      })

      this.queue.complete(job.id, { overridden: true, style, price_range: priceRange })
      this.stats.completed++
      this.stats.overridden++
      return
    }

    // Require scraped signal for LLM (avoid guessing from name only)
    if (!['fetch', 'browser'].includes(row.scrape_method) && !row.osm_tags && !row.source_evidence?.length) {
      this.queue.complete(job.id, { skipped: 'no_signal' })
      this.stats.completed++
      return
    }

    const prompt = buildPrompt(row, entity)
    console.log(`[${this.workerId}] Prompt size for job ${job.id}: ${prompt.length} chars`)

    let resp
    try {
      resp = await ollamaGenerate(prompt, {
        onController: controller => {
          this.activeOllamaController = controller
        }
      })
    } catch (err) {
      const msg = err?.message || String(err)
      // Transient infra failure: requeue without burning attempts
      const isTransient =
        msg.includes('fetch failed') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('ENOTFOUND') ||
        msg.includes('ollama HTTP 5') ||
        msg.includes('Ollama request timeout') ||
        msg.includes('Classifier shutdown')

      if (isTransient) {
        this.queue.retry(job.id, msg, { refundAttempt: true })
        this.stats.retried++
        return
      }

      throw err
    }

    const parsed = safeJsonParse(resp)

    if (!parsed) {
      this.queue.fail(job.id, 'LLM output parse failed')
      this.stats.failed++
      return
    }

    let style = normalizeStyle(parsed.style, entity)
    const priceRange = normalizePrice(parsed.price_range)
    let styleConfidence = parsed.style_confidence === 'confirmed' ? 'confirmed' : 'inferred'

    // Extra guardrail: require source evidence before writing any LLM style.
    // A model may still provide price without enough evidence for pizza style.
    if (entity === 'pizza' && style && !hasStyleEvidence(row, style)) {
      style = null
      styleConfidence = null
    }

    // Conservative write: nulls allowed; never write unknown values
    await this.updateCanonicalRow(row.id, entity, {
      style,
      price_range: priceRange,
      style_confidence: style ? styleConfidence : null
    })

    this.queue.complete(job.id, { style, price_range: priceRange, style_confidence: styleConfidence })
    this.stats.completed++
  }

  async run() {
    await this.init()
    this.running = true

    console.log(`[${this.workerId}] LLM Classifier started (model=${MODEL})`)
    if (process.send) process.send({ type: 'ready' })

    const heartbeatInterval = setInterval(() => {
      try {
        this.queue.heartbeat(this.workerId)
        if (process.send) process.send({ type: 'heartbeat' })
      } catch (error) {
        console.error(`[${this.workerId}] Heartbeat error:`, error.message)
        // Don't exit on heartbeat errors; they're non-critical
      }
    }, 30000)
    let lastOrphanRecoveryAt = 0

    process.on('message', (msg) => {
      if (msg.type === 'shutdown') this.requestShutdown('shutdown message')
    })

    const stop = signal => this.requestShutdown(signal)
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)

    try {
      while (this.running) {
        try {
          if (Date.now() - lastOrphanRecoveryAt >= 60000) {
            const recovered = this.queue.recoverOrphaned(10, { requireDetachedWorker: true, jobTypes: ['classify'] })
            if (recovered > 0) console.log(`[${this.workerId}] Recovered ${recovered} detached stale classify job(s)`)
            lastOrphanRecoveryAt = Date.now()
          }

          // Preflight Ollama so we don't claim jobs (and increment attempts) when it's down.
          const now = Date.now()
          if (now - this.ollamaHealth.lastCheckedAt > OLLAMA_HEALTHCHECK_INTERVAL_MS || !this.ollamaHealth.ok) {
            const health = await ollamaIsHealthy()
            this.ollamaHealth = {
              ok: health.ok,
              lastCheckedAt: now,
              lastError: health.error
            }

            if (!health.ok) {
              console.error(`[${this.workerId}] Ollama unhealthy (${health.error}); backing off before claiming jobs...`)
              await new Promise(r => setTimeout(r, 15000))
              continue
            }
          }

          const job = this.queue.claim('classify', this.workerId)

          if (!job) {
            await new Promise(r => setTimeout(r, 5000))
            continue
          }

          this.currentJob = job
          console.log(`[${this.workerId}] Claimed classify job ${job.id} (${job.osmId})`)

          try {
            await this.processJob(job)
          } catch (e) {
            this.queue.fail(job.id, e.message)
            this.stats.failed++
          } finally {
            this.currentJob = null
          }

          this.sendStats('running')
          if (this.maxJobs > 0 && this.stats.completed + this.stats.failed + this.stats.retried >= this.maxJobs) {
            console.log(`[${this.workerId}] Reached max jobs (${this.maxJobs}); stopping`)
            this.running = false
            break
          }
          // rate limit LLM calls
          await new Promise(r => setTimeout(r, 750))
        } catch (error) {
          // Handle transient SQLite errors (SQLITE_BUSY, SQLITE_LOCKED) gracefully
          if (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED') {
              console.error(`[${new Date().toISOString()}] [${this.workerId}] Database contention (${error.code}), backing off...`)
            await new Promise(r => setTimeout(r, 10000 + Math.random() * 5000)) // 10-15s backoff
          } else {
            console.error(`[${new Date().toISOString()}] [${this.workerId}] Unexpected error in main loop:`, error)
            await new Promise(r => setTimeout(r, 5000))
          }
        }
      }
    } finally {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)

      if (this.currentJob) {
        try {
          this.queue.retry(this.currentJob.id, 'Classifier stopped before completing job', { refundAttempt: true })
          console.log(`[${this.workerId}] Requeued in-flight job ${this.currentJob.id} during shutdown`)
        } catch (error) {
          console.error(`[${this.workerId}] Failed to requeue in-flight job ${this.currentJob.id}:`, error.message)
        } finally {
          this.currentJob = null
        }
      }

      clearInterval(heartbeatInterval)
      await this.shutdown()
      console.log(`[${this.workerId}] LLM Classifier stopped`)
    }
  }
}

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage:
  node scripts/enrichment/agents/llm-classifier.mjs [options]

Options:
  --worker-id <id>   Worker id to register in the SQLite queue.
  --max-jobs <n>     Stop after processing n classify jobs. Defaults to CLASSIFY_MAX_JOBS or unlimited.
  -h, --help         Show this help text without starting a worker.

Environment:
  CLASSIFY_MAX_JOBS
  OLLAMA_MODEL
  OLLAMA_TIMEOUT_MS
  OLLAMA_NUM_PREDICT
  OLLAMA_TEMPERATURE
`)
  process.exit(0)
}
const workerIdIdx = args.indexOf('--worker-id')
const workerId = workerIdIdx >= 0 ? args[workerIdIdx + 1] : `classify-${Date.now()}`
const maxJobsIdx = args.indexOf('--max-jobs')
const maxJobs = maxJobsIdx >= 0 ? parseInt(args[maxJobsIdx + 1], 10) : parseInt(process.env.CLASSIFY_MAX_JOBS || '0', 10)

const worker = new LlmClassifier(workerId, {
  maxJobs: Number.isFinite(maxJobs) && maxJobs > 0 ? maxJobs : 0
})
worker.run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
