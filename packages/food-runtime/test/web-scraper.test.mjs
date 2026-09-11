import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { placeLookupQuery, WebScraper } from '../scripts/enrichment/agents/web-scraper.mjs'

test('the Taco lookup omits Pizza-only menu_data while Pizza keeps it', () => {
  const tacoQuery = placeLookupQuery('taco')
  const pizzaQuery = placeLookupQuery('pizza')

  assert.match(tacoQuery, /FROM taco_places/)
  assert.doesNotMatch(tacoQuery, /menu_data/)
  assert.match(pizzaQuery, /FROM pizza_places/)
  assert.match(pizzaQuery, /menu_data/)
})

test('a Taco scrape uses the real lookup and hands fresh evidence to the Taco classifier', async () => {
  const queries = []
  const addedJobs = []
  const completedJobs = []
  const queue = {
    addJob: (...args) => {
      addedJobs.push(args)
      return true
    },
    complete: (...args) => completedJobs.push(args),
  }
  const pgClient = {
    async query(sql, params) {
      queries.push({ sql, params })
      if (sql.includes('FROM website_cache')) return { rows: [] }
      if (sql.includes('FROM taco_places')) {
        return {
          rows: [{
            website_url: 'https://example.test/tacos',
            state: 'MI',
            style: null,
            price_range: null,
          }],
        }
      }
      throw new Error(`unexpected query: ${sql}`)
    },
  }
  const scraper = new WebScraper('test-taco-scraper', { queue, pgClient })
  scraper.fetchWithTimeout = async () => ({
    html: '<html><body>Call (313) 555-0100 for carnitas.</body></html>',
    finalUrl: 'https://example.test/tacos',
    statusCode: 200,
  })
  scraper.saveToCache = async () => {}
  scraper.updateDb = async () => {}

  await scraper.processJob({ id: 7, osmId: 'osm:way/42', placeType: 'taco', data: {} })

  const lookup = queries.find(query => query.sql.includes('FROM taco_places'))
  assert.ok(lookup, 'the Taco canonical lookup should run')
  assert.doesNotMatch(lookup.sql, /menu_data/)
  assert.deepEqual(lookup.params, ['osm:way/42'])
  assert.deepEqual(addedJobs, [['classify', 'osm:way/42', 'taco', { state: 'MI' }]])
  assert.equal(completedJobs.length, 1)
  assert.equal(completedJobs[0][0], 7)
  assert.equal(completedJobs[0][1].scrape_method, undefined)
  assert.equal(completedJobs[0][1].phone, '3135550100')
})

test('the worker CLI main guard follows a prepared symlink', t => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'food-runtime-scraper-cli-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const script = fileURLToPath(new URL('../scripts/enrichment/agents/web-scraper.mjs', import.meta.url))
  const symlink = join(directory, 'web-scraper.mjs')
  symlinkSync(script, symlink)

  const result = spawnSync(process.execPath, [symlink, '--help'], { encoding: 'utf8' })

  assert.equal(result.status, 0)
  assert.match(result.stdout, /Usage:\s+node scripts\/enrichment\/agents\/web-scraper\.mjs/)
  assert.equal(result.stderr, '')
})
