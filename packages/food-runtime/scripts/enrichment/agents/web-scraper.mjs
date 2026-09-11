#!/usr/bin/env node
/**
 * Web Scraper Agent
 *
 * Worker agent that fetches and extracts data from restaurant websites.
 * Respects rate limits and handles timeouts gracefully.
 *
 * Usage:
 *   node web-scraper.mjs --worker-id scraper-1
 *   node web-scraper.mjs --worker-id scraper-smoke --max-jobs 10
 *   SCRAPE_REQUEUE_BATCH=0 node web-scraper.mjs --worker-id scraper-smoke --max-jobs 10
 */

import { getQueue } from '../queue.mjs'
import pg from 'pg'
import * as cheerio from 'cheerio'
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import 'dotenv/config'
import { normalizeWebsiteUrl } from '../../lib/website-url.mjs'
import { enqueueClassificationHandoff } from '../../lib/classification-handoff.mjs'
import { enrichmentEntity } from '../../lib/enrichment-entity.mjs'

const CONCURRENT_FETCHES = 5

// Network tuning
// - Default timeout bumped to 30s to reduce false failures on slow sites.
// - Can be overridden per-run via env.
const FETCH_TIMEOUT = Number.parseInt(process.env.SCRAPE_FETCH_TIMEOUT_MS || '30000', 10) // ms
const FETCH_DELAY = Number.parseInt(process.env.SCRAPE_FETCH_DELAY_MS || '500', 10)      // ms between jobs
const BROWSER_TIMEOUT = Number.parseInt(process.env.SCRAPE_BROWSER_TIMEOUT_MS || '30000', 10)
const BROWSER_DOMAINS = new Set(
  (process.env.SCRAPE_BROWSER_FALLBACK_DOMAINS || '')
    .split(',')
    .map(domain => domain.trim().toLowerCase())
    .filter(Boolean)
)
const BROWSER_EXECUTABLE = process.env.SCRAPE_BROWSER_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

// Retry policy
// - Still retries HTTP 5xx.
// - Also retries transient network/abort errors.
const MAX_RETRIES = Number.parseInt(process.env.SCRAPE_MAX_RETRIES || '3', 10)

// Automatically requeue previously-failed scrape jobs in conservative batches.
// This avoids having to manually run batches, while still spacing actual requests.
const REQUEUE_BATCH = Number.parseInt(process.env.SCRAPE_REQUEUE_BATCH || '100', 10)
const REQUEUE_INTERVAL_MS = Number.parseInt(process.env.SCRAPE_REQUEUE_INTERVAL_MS || '60000', 10)
const REQUEUE_PENDING_MAX = Number.parseInt(process.env.SCRAPE_REQUEUE_PENDING_MAX || '200', 10)

// Where to record "can't scrape" cases so we can revisit later.
// Keep it simple: append-only JSONL file in /tmp/openclaw by default.
const CANT_SCRAPE_LOG = process.env.SCRAPE_CANT_SCRAPE_LOG || '/tmp/openclaw/scrape-cant-scrape.jsonl'
const logPrefix = workerId => `[${new Date().toISOString()}] [${workerId}]`

function isCantScrapeErrorMessage(msg) {
  if (!msg) return false
  // Treat these as permanent/expected failures for now.
  return (
    /^HTTP (403|404|410|520|521|523|525|526|530)$/.test(msg) ||
    msg.startsWith('Non-HTML content:') ||
    /(?:getaddrinfo|dns).*ENOTFOUND|\bENOTFOUND\b/i.test(msg)
  )
}

function shouldRetryErrorMessage(msg) {
  if (!msg) return false
  if (/^HTTP 5\d{2}$/.test(msg)) return true
  // Node fetch transient errors often show up as these strings.
  if (msg === 'fetch failed') return true
  if (msg === 'This operation was aborted') return true
  return false
}

function logCantScrape(entry) {
  try {
    const dir = path.dirname(CANT_SCRAPE_LOG)
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(CANT_SCRAPE_LOG, `${JSON.stringify(entry)}\n`)
  } catch {
    // never crash the worker because logging failed
  }
}

export function placeLookupQuery(placeType) {
  const { entity, table } = enrichmentEntity(placeType)
  // Taco's canonical table deliberately has no menu_data column. Menu
  // parsing is a Pizza-only slowlane, so keep that optional field out of the
  // shared Taco lookup while preserving the existing Pizza projection.
  const columns = ['website_url', 'state', 'style', 'price_range']
  if (entity === 'pizza') columns.push('menu_data')
  return `
      SELECT ${columns.join(', ')}
      FROM ${table}
      WHERE google_place_id = $1
    `
}

export class WebScraper {
  lastRequeueAt = 0

  queueEntityClause() {
    return this.placeType ? { sql: ' AND place_type = ?', params: [this.placeType] } : { sql: '', params: [] }
  }

  cleanupUnclaimablePending() {
    // If a scrape job is "pending" but attempts are exhausted, it will never be claimable.
    // Flip to failed so the queue doesn't look stuck.
    try {
      const scope = this.queueEntityClause()
      return this.queue.db
        .prepare(
          `
          UPDATE jobs
          SET status='failed', completed_at=datetime('now')
          WHERE job_type='scrape'
            AND status='pending'
            AND attempts >= max_attempts
            ${scope.sql}
          `
        )
        .run(...scope.params).changes
    } catch {
      return 0
    }
  }

  maybeRequeueFailedBatch() {
    if (REQUEUE_BATCH <= 0) return { requeued: 0, cleaned: 0 }

    const now = Date.now()
    if (now - this.lastRequeueAt < REQUEUE_INTERVAL_MS) return { requeued: 0, cleaned: 0 }

    // Don't keep requeueing if we already have a healthy buffer.
    const scope = this.queueEntityClause()
    const pending = this.queue.db
      .prepare(`SELECT COUNT(*) n FROM jobs WHERE job_type='scrape' AND status='pending'${scope.sql}`)
      .get(...scope.params).n

    const cleaned = this.cleanupUnclaimablePending()

    if (pending > REQUEUE_PENDING_MAX) {
      this.lastRequeueAt = now
      return { requeued: 0, cleaned }
    }

    const candidates = this.queue.db
      .prepare(
        `
        SELECT id, last_error
        FROM jobs
        WHERE job_type='scrape'
          AND status='failed'
          AND last_error IS NOT NULL
          ${scope.sql}

          -- include transient-ish
          AND (
            last_error LIKE '%fetch failed%'
            OR last_error LIKE '%This operation was aborted%'
            OR last_error LIKE '%timeout%'
            OR last_error LIKE 'HTTP 5%'
            OR last_error LIKE '%ECONNRESET%'
            OR last_error LIKE '%ETIMEDOUT%'
          )

          -- exclude 403s and permanent-ish
          AND last_error NOT LIKE 'HTTP 403%'
          AND last_error NOT LIKE 'Cached error: HTTP 403%'
          AND last_error NOT LIKE 'HTTP 404%'
          AND last_error NOT LIKE 'Cached error: HTTP 404%'
          AND last_error NOT LIKE 'HTTP 410%'
          AND last_error NOT LIKE 'Cached error: HTTP 410%'

        ORDER BY id ASC
        LIMIT ?
        `
      )
      .all(...scope.params, REQUEUE_BATCH)

    if (!candidates.length) {
      this.lastRequeueAt = now
      return { requeued: 0, cleaned }
    }

    const stamp = new Date().toISOString()
    const tx = this.queue.db.transaction((rows) => {
      const stmt = this.queue.db.prepare(
        `
        UPDATE jobs
        SET status='pending',
            worker_id=NULL,
            started_at=NULL,
            completed_at=NULL,
            attempts=0,
            last_error=?,
            data=json_set(COALESCE(data, '{}'), '$.skipCache', 1)
        WHERE id=?
        `
      )
      for (const r of rows) {
        stmt.run(`requeued ${stamp} (was: ${String(r.last_error).slice(0, 120)})`, r.id)
      }
    })

    this.queue.withBusyRetry(() => tx.immediate(candidates))
    this.lastRequeueAt = now
    console.log(`[${this.workerId}] Requeued ${candidates.length} failed scrape jobs (batch)`)
    return { requeued: candidates.length, cleaned }
  }

  constructor(workerId, { maxJobs = 0, placeType = null, queue = null, pgClient = null } = {}) {
    this.workerId = workerId
    this.maxJobs = maxJobs
    this.placeType = placeType
    this.queue = queue || getQueue()
    this.pgClient = pgClient
    this.running = false
    this.currentJob = null
    this.stats = { completed: 0, failed: 0 }
  }

  async init() {
    if (!this.pgClient) {
      this.pgClient = new pg.Client({
        host: 'localhost',
        database: 'pizza_enrichment',
        user: process.env.PGUSER || process.env.USER,
        password: process.env.PGPASSWORD || '',
        connectionTimeoutMillis: Number.parseInt(process.env.SCRAPE_DB_CONNECT_TIMEOUT_MS || '10000', 10),
        query_timeout: Number.parseInt(process.env.SCRAPE_DB_QUERY_TIMEOUT_MS || '15000', 10),
      })
      await this.pgClient.connect()
    }

    this.queue.registerWorker(this.workerId, 'scrape')
  }

  async shutdown() {
    this.running = false
    this.queue.unregisterWorker(this.workerId)
    this.queue.close()
    if (this.pgClient) await this.pgClient.end()
  }

  /**
   * Check if URL is in cache and still valid
   */
  async checkCache(url) {
    const result = await this.pgClient.query(`
      SELECT extracted_data, fetch_error
      FROM website_cache
      WHERE url = $1 AND expires_at > NOW()
    `, [url])

    return result.rows[0] || null
  }

  /**
   * Save to cache
   */
  async saveToCache(url, finalUrl, statusCode, data, error = null) {
    await this.pgClient.query(`
      INSERT INTO website_cache (url, final_url, status_code, extracted_data, fetch_error, fetched_at, expires_at)
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW() + INTERVAL '30 days')
      ON CONFLICT (url) DO UPDATE SET
        final_url = $2,
        status_code = $3,
        extracted_data = $4,
        fetch_error = $5,
        fetched_at = NOW(),
        expires_at = NOW() + INTERVAL '30 days'
    `, [url, finalUrl, statusCode, data ? JSON.stringify(data) : null, error])
  }

  /**
   * Fetch a website with timeout
   */
  async fetchWithTimeout(url) {
    const controller = new AbortController()
    let timeoutId
    const deadline = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort()
        reject(new Error(`Scrape fetch timeout after ${FETCH_TIMEOUT}ms`))
      }, FETCH_TIMEOUT)
    })

    try {
      const response = await Promise.race([fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PizzaBot/1.0; +https://apizzamichigan.com)',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        redirect: 'follow'
      }), deadline])

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const contentType = response.headers.get('content-type') || ''
      if (!contentType.includes('text/html')) {
        throw new Error(`Non-HTML content: ${contentType}`)
      }

      // Some servers deliver headers promptly but never finish the body. The
      // same deadline must cover response.text(), not just fetch().
      const html = await Promise.race([response.text(), deadline])
      return { html, finalUrl: response.url, statusCode: response.status }
    } catch (error) {
      throw error
    } finally {
      clearTimeout(timeoutId)
    }
  }

  shouldUseBrowserFallback(url) {
    if (BROWSER_DOMAINS.size === 0) return false
    try {
      const hostname = new URL(url).hostname.toLowerCase()
      return [...BROWSER_DOMAINS].some(domain => hostname === domain || hostname.endsWith(`.${domain}`))
    } catch {
      return false
    }
  }

  async fetchWithBrowser(url) {
    const browser = await chromium.launch({
      executablePath: BROWSER_EXECUTABLE,
      headless: true,
      args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check']
    })
    try {
      const page = await browser.newPage({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36 APizzaMichigan/1.0',
        extraHTTPHeaders: {
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      })
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: BROWSER_TIMEOUT
      })
      if (response && response.status() >= 400) {
        throw new Error(`HTTP ${response.status()}`)
      }
      await page.waitForTimeout(Math.min(1500, Math.max(0, BROWSER_TIMEOUT - 500)))
      return {
        html: await page.content(),
        finalUrl: page.url(),
        statusCode: response?.status() || 200
      }
    } finally {
      await browser.close()
    }
  }

  /**
   * Extract data from HTML
   */
  extractFromHtml(html, url) {
    const $ = cheerio.load(html)
    const data = {}

    // Extract JSON-LD (Schema.org) if present (high-signal)
    const jsonld = []
    $('script[type="application/ld+json"]').each((_, el) => {
      const raw = $(el).text()?.trim()
      if (!raw) return
      try {
        const parsed = JSON.parse(raw)
        jsonld.push(parsed)
      } catch {
        // Some sites embed invalid JSON-LD; ignore
      }
    })
    if (jsonld.length) {
      // Cap the amount we store to avoid huge payloads
      data.jsonld = jsonld.slice(0, 3)
    }

    // Extract phone numbers
    const phonePatterns = [
      /\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
      /\+1[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g
    ]
    const phoneText = $('body').text()
    for (const pattern of phonePatterns) {
      const matches = phoneText.match(pattern)
      if (matches && matches.length > 0) {
        // Clean and dedupe
        const phones = [...new Set(matches.map(p => p.replace(/[^\d+]/g, '')))]
        if (phones.length > 0) {
          data.phone = phones[0]
          break
        }
      }
    }

    // Look for phone in meta tags or structured data
    $('a[href^="tel:"]').each((_, el) => {
      if (!data.phone) {
        data.phone = $(el).attr('href').replace('tel:', '').replace(/[^\d+]/g, '')
      }
    })

    // Extract hours from common patterns
    const hoursKeywords = ['hours', 'schedule', 'open', 'close']
    $('*').each((_, el) => {
      const text = $(el).text().toLowerCase()
      if (hoursKeywords.some(kw => text.includes(kw))) {
        // Look for time patterns
        const timePattern = /\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM)/gi
        const times = $(el).text().match(timePattern)
        if (times && times.length >= 2) {
          data.hours_hint = $(el).text().slice(0, 200)
        }
      }
    })

    // Extract price hints
    const priceIndicators = {
      '$': /\$\d+(?:\.\d{2})?/g,
      'price': /(?:price|cost|starting at)[:\s]*\$?\d+/gi
    }
    const bodyText = $('body').text()

    // Store a capped cleaned text excerpt for LLM classification (reduced to 6K to stay within model context)
    const textExcerpt = bodyText.replace(/\s+/g, ' ').trim().slice(0, 6000)
    if (textExcerpt.length) data.text_excerpt = textExcerpt

    const prices = bodyText.match(priceIndicators['$']) || []
    if (prices.length > 0) {
      // Average price as hint
      const numericPrices = prices
        .map(p => parseFloat(p.replace(/[^\d.]/g, '')))
        .filter(p => p > 0 && p < 100)
      if (numericPrices.length > 0) {
        const avgPrice = numericPrices.reduce((a, b) => a + b, 0) / numericPrices.length
        data.price_hint = avgPrice < 10 ? '$' : avgPrice < 20 ? '$$' : avgPrice < 35 ? '$$$' : '$$$$'
      }
    }

    // Extract menu link
    $('a').each((_, el) => {
      const href = $(el).attr('href') || ''
      const text = $(el).text().toLowerCase()
      if (text.includes('menu') && !data.menu_url) {
        data.menu_url = href.startsWith('http') ? href : new URL(href, url).href
      }
    })

    // Extract style hints for pizza
    const pizzaStyles = ['detroit', 'new york', 'chicago', 'neapolitan', 'sicilian', 'tavern', 'deep dish', 'thin crust', 'wood fired', 'brick oven']
    const lowerBody = bodyText.toLowerCase()
    for (const style of pizzaStyles) {
      if (lowerBody.includes(style)) {
        data.style_hints = data.style_hints || []
        data.style_hints.push(style)
      }
    }

    // Extract protein hints for tacos
    const tacoProteins = ['al pastor', 'carne asada', 'carnitas', 'birria', 'chorizo', 'pollo', 'barbacoa', 'lengua', 'cabeza', 'fish', 'shrimp']
    for (const protein of tacoProteins) {
      if (lowerBody.includes(protein)) {
        data.protein_hints = data.protein_hints || []
        data.protein_hints.push(protein)
      }
    }

    return Object.keys(data).length > 0 ? data : null
  }

  /**
   * Process a single job
   */
  async processJob(job) {
    // Get the website URL (and some metadata) from the database
    const result = await this.pgClient.query(placeLookupQuery(job.placeType), [job.osmId])

    if (!result.rows[0]?.website_url) {
      // No website to scrape, skip
      this.queue.complete(job.id, { skipped: 'no_website' })
      this.stats.completed++
      return
    }

    const { website_url: rawUrl, state, style, price_range: priceRange, menu_data: menuData } = result.rows[0]
    const url = normalizeWebsiteUrl(rawUrl)

    if (!url) {
      this.queue.complete(job.id, { status: 'invalid_url', source_url: rawUrl })
      this.stats.completed++
      return
    }

    // Skip cache if this job was explicitly requeued for a fresh retry
    const skipCache = job.data?.skipCache === 1

    // Check cache (unless skipCache is set)
    const cached = skipCache ? null : await this.checkCache(url)
    if (cached) {
      if (cached.fetch_error) {
        const msg = String(cached.fetch_error)
        if (isCantScrapeErrorMessage(msg)) {
          logCantScrape({
            ts: new Date().toISOString(),
            source: 'cache',
            osmId: job.osmId,
            placeType: job.placeType,
            url,
            error: msg
          })
          this.queue.complete(job.id, { status: 'cant_scrape', reason: msg })
          this.stats.completed++
        } else {
          this.queue.fail(job.id, `Cached error: ${msg}`)
          this.stats.failed++
        }
      } else {
        // Update database with cached data
        await this.updateDb(job.osmId, job.placeType, cached.extracted_data)

        // Handoff: both product entities share the classifier worker, while
        // their queue identity and canonical table remain entity-scoped.
        enqueueClassificationHandoff(this.queue, job, { state, style, priceRange })

        // Slowlane: enqueue menu parsing (pizza-only) if we don't already have menu_data and slowlane isn't paused
        if (job.placeType === 'pizza' && menuData == null && !this.queue.isPaused('menu_parse')) {
          this.queue.addJob('menu_parse', job.osmId, job.placeType, { state })
        }

        this.queue.complete(job.id, cached.extracted_data)
        this.stats.completed++
      }
      return
    }

    // Fetch the website (with retry for transient errors)
    let lastError = null
    let browserAttempted = false
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const { html, finalUrl, statusCode } = await this.fetchWithTimeout(url)
        const extracted = this.extractFromHtml(html, finalUrl)

        await this.saveToCache(url, finalUrl, statusCode, extracted)

        if (extracted) {
          await this.updateDb(job.osmId, job.placeType, extracted)

          // Handoff to the entity-aware classifier.
          enqueueClassificationHandoff(this.queue, job, { state, style, priceRange })

          // Slowlane: enqueue menu parsing (pizza-only) if we don't already have menu_data and slowlane isn't paused
          if (job.placeType === 'pizza' && menuData == null && !this.queue.isPaused('menu_parse')) {
            this.queue.addJob('menu_parse', job.osmId, job.placeType, { state })
          }
        }

        this.queue.complete(job.id, extracted || { status: 'no_data_extracted' })
        this.stats.completed++
        return
      } catch (error) {
        lastError = error
        const msg = String(error?.message || error)

        // Browser rendering is deliberately opt-in and limited to configured domains.
        if (!browserAttempted && this.shouldUseBrowserFallback(url)) {
          browserAttempted = true
          try {
            const browserResult = await this.fetchWithBrowser(url)
            const extracted = this.extractFromHtml(browserResult.html, browserResult.finalUrl)
            await this.saveToCache(url, browserResult.finalUrl, browserResult.statusCode, extracted)
            await this.updateDb(job.osmId, job.placeType, extracted, 'browser')
            enqueueClassificationHandoff(this.queue, job, { state, style, priceRange })
            this.queue.complete(job.id, { ...extracted, scrape_method: 'browser' })
            this.stats.completed++
            return
          } catch (browserError) {
            lastError = new Error(`Browser fallback failed: ${browserError.message}`)
          }
        }

        // If it's a permanent/expected block/deadlink for now, don't keep retrying.
        if (isCantScrapeErrorMessage(msg)) {
          await this.saveToCache(url, null, null, null, msg)
          logCantScrape({
            ts: new Date().toISOString(),
            source: 'fetch',
            osmId: job.osmId,
            placeType: job.placeType,
            url,
            error: msg
          })
          this.queue.complete(job.id, { status: 'cant_scrape', reason: msg })
          this.stats.completed++
          return
        }

        // Retry transient errors (5xx, fetch failures, aborts)
        if (shouldRetryErrorMessage(msg) && attempt < MAX_RETRIES) {
          const backoffMs = 1500 * (attempt + 1)
          await new Promise(r => setTimeout(r, backoffMs))
          continue
        }

        // Otherwise, fail and let the queue's max_attempts policy decide.
        break
      }
    }

    // All retries exhausted or non-retryable error
    const msg = String(lastError?.message || lastError)
    await this.saveToCache(url, null, null, null, msg)
    this.queue.fail(job.id, msg)
    this.stats.failed++
  }

  /**
   * Update database with scraped data
   */
  async updateDb(osmId, placeType, data, scrapeMethod = 'fetch') {
    if (!data) return

    const table = enrichmentEntity(placeType).table

    await this.pgClient.query(`
      UPDATE ${table}
      SET
        phone = COALESCE($2, phone),
        menu_url = COALESCE($4, menu_url),
        scrape_method = $5,
        scrape_notes = $3,
        last_enriched_at = NOW()
      WHERE google_place_id = $1
    `, [
      osmId,
      data.phone,
      JSON.stringify(data),
      data.menu_url || null,
      scrapeMethod
    ])
  }

  /**
   * Send stats to coordinator
   */
  sendStats() {
    if (process.send) {
      process.send({
        type: 'stats',
        stats: {
          status: 'running',
          completed: this.stats.completed,
          failed: this.stats.failed
        }
      })
    }
  }

  /**
   * Main run loop
   */
  async run() {
    await this.init()
    this.running = true

    console.log(`[${this.workerId}] Web Scraper started`)

    if (process.send) {
      process.send({ type: 'ready' })
    }

    // Heartbeat interval
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

    // Handle shutdown message
    process.on('message', async (msg) => {
      if (msg.type === 'shutdown') {
        this.running = false
      }
    })

    const stop = signal => {
      console.log(`[${this.workerId}] Received ${signal}; stopping after current job`)
      this.running = false
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)

    try {
      // Main loop
      while (this.running) {
        try {
          if (Date.now() - lastOrphanRecoveryAt >= 60000) {
            const recovered = this.queue.recoverOrphaned(10, {
              requireDetachedWorker: true,
              jobTypes: ['scrape'],
              placeTypes: this.placeType ? [this.placeType] : null,
            })
            if (recovered > 0) console.log(`[${this.workerId}] Recovered ${recovered} detached stale scrape job(s)`)
            lastOrphanRecoveryAt = Date.now()
          }

          // Periodically requeue failed jobs before claiming (so it runs even when processing)
          this.maybeRequeueFailedBatch()

          const job = this.queue.claim('scrape', this.workerId, { placeType: this.placeType })

          if (job) {
            this.currentJob = job
            try {
              await this.processJob(job)
            } catch (error) {
              const msg = error?.message || String(error)
              console.error(`[${this.workerId}] Failed scrape job ${job.id} (${job.osmId}):`, msg)
              this.queue.fail(job.id, msg)
              this.stats.failed++
            } finally {
              this.currentJob = null
            }

            this.sendStats()
            if (this.maxJobs > 0 && this.stats.completed + this.stats.failed >= this.maxJobs) {
              console.log(`[${this.workerId}] Reached max jobs (${this.maxJobs}); stopping`)
              this.running = false
              break
            }
            await new Promise(r => setTimeout(r, FETCH_DELAY))
          } else {
            // No pending jobs right now, wait a bit before checking again
            await new Promise(r => setTimeout(r, 5000))
          }
        } catch (error) {
          // Handle transient SQLite errors (SQLITE_BUSY, SQLITE_LOCKED) gracefully
          if (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED') {
              console.error(`${logPrefix(this.workerId)} Database contention (${error.code}), backing off...`)
            await new Promise(r => setTimeout(r, 10000 + Math.random() * 5000)) // 10-15s backoff
          } else {
            console.error(`${logPrefix(this.workerId)} Unexpected error in main loop:`, error)
            await new Promise(r => setTimeout(r, 5000))
          }
        }
      }
    } finally {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)

      if (this.currentJob) {
        try {
          this.queue.retry(this.currentJob.id, 'Web scraper stopped before completing job', { refundAttempt: true })
          console.log(`[${this.workerId}] Requeued in-flight job ${this.currentJob.id} during shutdown`)
        } catch (error) {
          console.error(`[${this.workerId}] Failed to requeue in-flight job ${this.currentJob.id}:`, error.message)
        } finally {
          this.currentJob = null
        }
      }

      clearInterval(heartbeatInterval)
      await this.shutdown()
      console.log(`[${this.workerId}] Web Scraper stopped`)
    }
  }
}

// Run only when invoked as a worker. Keeping the entrypoint side effect-free
// when imported lets focused tests exercise the real scraper methods without
// opening a production queue or database connection.
if (process.argv[1]
  && fs.existsSync(path.resolve(process.argv[1]))
  && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage:
  node scripts/enrichment/agents/web-scraper.mjs [options]

Options:
  --worker-id <id>   Worker id to register in the SQLite queue.
  --max-jobs <n>     Stop after processing n scrape jobs. Defaults to SCRAPE_MAX_JOBS or unlimited.
  --place-type <name> Restrict claims and queue maintenance to pizza or taco.
  -h, --help         Show this help text without starting a worker.

Environment:
  SCRAPE_MAX_JOBS
  SCRAPE_FETCH_TIMEOUT_MS
  SCRAPE_FETCH_DELAY_MS
  SCRAPE_MAX_RETRIES
`)
    process.exit(0)
  }
  const workerIdIdx = args.indexOf('--worker-id')
  const workerId = workerIdIdx >= 0 ? args[workerIdIdx + 1] : `scraper-${Date.now()}`
  const maxJobsIdx = args.indexOf('--max-jobs')
  const maxJobs = maxJobsIdx >= 0 ? parseInt(args[maxJobsIdx + 1], 10) : parseInt(process.env.SCRAPE_MAX_JOBS || '0', 10)
  const placeTypeIdx = args.indexOf('--place-type')
  const placeType = placeTypeIdx >= 0 ? String(args[placeTypeIdx + 1] || '').trim().toLowerCase() : null
  if (placeType !== null && !['pizza', 'taco'].includes(placeType)) throw new Error('Invalid --place-type; use pizza or taco')

  const scraper = new WebScraper(workerId, {
    maxJobs: Number.isFinite(maxJobs) && maxJobs > 0 ? maxJobs : 0,
    placeType,
  })
  scraper.run().catch(console.error)
}
