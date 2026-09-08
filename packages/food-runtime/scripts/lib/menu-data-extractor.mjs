/**
 * Extract high-confidence menu facts from scraper evidence without an LLM.
 * This is intentionally conservative: it records URLs and structured menu
 * items, but never invents dishes or prices from free-form text.
 */

const MENU_URL_KEYS = ['menu', 'menu_url', 'hasMenu']

function asObject(value) {
  return value && typeof value === 'object' ? value : null
}

function asArray(value) {
  if (Array.isArray(value)) return value
  return value ? [value] : []
}

function cleanText(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text || null
}

function jsonLdEntries(jsonld) {
  return asArray(jsonld).flatMap(entry => {
    const object = asObject(entry)
    if (!object) return []
    return Array.isArray(object['@graph']) ? object['@graph'].filter(Boolean) : [object]
  })
}

function absoluteUrl(value, baseUrl) {
  const text = cleanText(value)
  if (!text) return null
  try {
    return new URL(text, baseUrl || undefined).toString()
  } catch {
    return /^https?:\/\//i.test(text) ? text : null
  }
}

function collectMenuUrls(evidence, entries) {
  const values = []
  for (const key of MENU_URL_KEYS) {
    if (evidence?.[key]) values.push(...asArray(evidence[key]))
  }
  for (const entry of entries) {
    for (const key of MENU_URL_KEYS) {
      if (entry?.[key]) values.push(...asArray(entry[key]))
    }
  }
  return [...new Set(values.map(value => {
    if (typeof value === 'object') return value.url || value['@id']
    return value
  }).map(value => absoluteUrl(value, evidence?.website_url)).filter(Boolean))]
}

function menuItems(entries) {
  const items = []
  for (const entry of entries) {
    const menu = asObject(entry?.hasMenu)
    const candidates = [
      ...asArray(entry?.hasMenuItem),
      ...asArray(menu?.hasMenuItem),
      ...asArray(menu?.hasMenuSection).flatMap(section => asArray(section?.hasMenuItem)),
    ]
    for (const item of candidates) {
      const object = asObject(item)
      if (!object) continue
      const name = cleanText(object.name)
      if (!name) continue
      const price = cleanText(object.price || object.priceSpecification?.price)
      items.push({ name, ...(price ? { price } : {}) })
    }
  }
  const seen = new Set()
  return items.filter(item => {
    const key = `${item.name.toLowerCase()}|${item.price || ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 100)
}

export function extractMenuData(scrapeNotes, { websiteUrl = null } = {}) {
  const evidence = typeof scrapeNotes === 'string'
    ? (() => { try { return JSON.parse(scrapeNotes) } catch { return { text_excerpt: scrapeNotes } } })()
    : asObject(scrapeNotes) || {}
  const entries = jsonLdEntries(evidence.jsonld)
  const menuUrls = collectMenuUrls({ ...evidence, website_url: websiteUrl || evidence.website_url }, entries)
  const items = menuItems(entries)
  const hasStructuredMenu = items.length > 0
  const hasMenuSignal = hasStructuredMenu || menuUrls.length > 0 || Boolean(evidence.menu_url)
  if (!hasMenuSignal) return null

  return {
    has_menu: true,
    menu_urls: menuUrls,
    ordering_urls: [],
    signature_pizzas: [],
    toppings: [],
    dietary_options: [],
    ...(items.length ? { items } : {}),
    price_examples: {
      small: null,
      medium: null,
      large: null,
      slice: null,
    },
    extraction_method: hasStructuredMenu ? 'schema_menu_items' : 'schema_or_scraped_menu_url',
    confidence: hasStructuredMenu ? 'high' : 'medium',
  }
}

export function normalizeMenuResult(result) {
  const object = asObject(result)
  if (!object?.has_menu) return null
  return extractMenuData(object, { websiteUrl: object.website_url }) || object
}
