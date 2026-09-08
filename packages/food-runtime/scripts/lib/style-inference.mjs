/**
 * Style and price inference from restaurant names
 */

import { normalizePizzaStyle } from './pizza-style-taxonomy.mjs'

// Chain name to style mappings
const CHAIN_STYLE_MAP = {
  // St. Louis must precede the overlapping "louis pizza" Detroit key.
  "st. louis pizza": 'St. Louis',
  "st louis pizza": 'St. Louis',

  // Detroit Style (square, thick, crispy edges)
  "buddy's": 'Detroit',
  "buddy's pizza": 'Detroit',
  "shield's": 'Detroit',
  "shields pizza": 'Detroit',
  "jet's": 'Detroit',
  "jets": 'Detroit',
  "jets pizza": 'Detroit',
  "loui's": 'Detroit',
  "louis pizza": 'Detroit',
  "cloverleaf": 'Detroit',
  "michigan & trumbull": 'Detroit',
  "supino": 'Detroit',
  "via 313": 'Detroit',
  "blue pan": 'Detroit',

  // Chicago Style (deep dish)
  "lou malnati's": 'Chicago Deep Dish',
  "lou malnatis": 'Chicago Deep Dish',
  "giordano's": 'Chicago Deep Dish',
  "giordanos": 'Chicago Deep Dish',
  "pequod's": 'Chicago Deep Dish',
  "pequods": 'Chicago Deep Dish',
  "gino's east": 'Chicago Deep Dish',
  "ginos east": 'Chicago Deep Dish',
  "chicago's pizza": 'Chicago Deep Dish',
  "chicago pizza": 'Chicago Deep Dish',
  "uno pizzeria": 'Chicago Deep Dish',
  "due pizzeria": 'Chicago Deep Dish',

  // National Chains (Traditional)
  "little caesars": 'Standard Round',
  "little caesar's": 'Standard Round',
  "domino's": 'Standard Round',
  "dominos": 'Standard Round',
  "pizza hut": 'Standard Round',
  "papa john's": 'Standard Round',
  "papa johns": 'Standard Round',
  "marco's": 'Standard Round',
  "marcos pizza": 'Standard Round',
  "hungry howie's": 'Standard Round',
  "hungry howies": 'Standard Round',
  "papa murphy's": 'Standard Round',
  "papa murphys": 'Standard Round',
  "papa romano's": 'Standard Round',
  "papa romanos": 'Standard Round',
  "b.c. pizza": 'Standard Round',
  "bc pizza": 'Standard Round',
  "best choice pizza": 'Standard Round',
  "chuck e. cheese": 'Standard Round',
  "chuck e cheese": 'Standard Round',
  "cici's": 'Standard Round',
  "cicis pizza": 'Standard Round',
  "sbarro": 'New York',
  "godfather's": 'Standard Round',
  "godfathers pizza": 'Standard Round',
  "fox's pizza": 'Standard Round',
  "foxs pizza": 'Standard Round',
  "round table": 'Standard Round',
  "simple simon's": 'Standard Round',
  "simple simons": 'Standard Round',
  "simple simon's pizza": 'Standard Round',
  "simple simons pizza": 'Standard Round',
  "mountain mike's": 'Standard Round',
  "pizza ranch": 'Standard Round',
  "toppers pizza": 'Standard Round',
  "donatos": 'Standard Round',
  "mod pizza": 'Standard Round',
  "blaze pizza": 'Standard Round',
  "pieology": 'Standard Round',
  "your pie": 'Standard Round',
  "&pizza": 'Standard Round',
  "larosa's": 'Standard Round',
  "larosas": 'Standard Round',
  "larosa's pizzeria": 'Standard Round',
  "larosas pizzeria": 'Standard Round',
  "sal's pizza": 'Standard Round',
  "sals pizza": 'Standard Round',

  // Michigan regional chains
  "cottage inn": 'Standard Round',
  "mancino's": 'Standard Round',
  "mancinos": 'Standard Round',
  "pizza house": 'Standard Round',
  "backroom pizza": 'Standard Round',
  "toarmina's": 'Standard Round',
  "toarminas": 'Standard Round',
}

// Brand identifiers are less ambiguous than display names. Keep this catalog
// intentionally small: each entry represents the brand's primary pizza style.
const WIKIDATA_BRAND_STYLE_MAP = {
  // California Pizza Kitchen specializes in California-style pizza.
  Q15109854: 'California',
  // Uno's origin and signature product are Chicago deep dish.
  Q7897209: 'Chicago Deep Dish',
  // Happy's serves conventional round pizzas across its Metro Detroit stores.
  Q5652393: 'Standard Round',
}

// Keywords that suggest specific styles
const STYLE_KEYWORDS = {
  // Detroit
  'detroit': 'Detroit',
  'detroit style': 'Detroit',
  'detroit-style': 'Detroit',
  'square pan': 'Detroit',

  // Chicago
  'new haven': 'New Haven / Connecticut',
  'new haven style': 'New Haven / Connecticut',
  'connecticut style': 'New Haven / Connecticut',
  'apizza': 'New Haven / Connecticut',

  // Chicago regional styles
  'chicago tavern': 'Chicago Tavern',
  'chicago thin': 'Chicago Tavern',
  'chicago': 'Chicago Deep Dish',
  'deep dish': 'Chicago Deep Dish',
  'deep-dish': 'Chicago Deep Dish',
  'stuffed pizza': 'Chicago Deep Dish',

  // New York
  'new york': 'New York',
  'ny style': 'New York',
  'ny-style': 'New York',
  'brooklyn': 'New York',
  'slice house': 'New York',
  'slice shop': 'New York',

  // Neapolitan
  'neapolitan': 'Neapolitan',
  'napoletana': 'Neapolitan',
  'napoli': 'Neapolitan',
  'wood fired': 'Neapolitan',
  'wood-fired': 'Neapolitan',
  'brick oven': 'Neapolitan',
  'coal fired': 'Neapolitan',
  'forno': 'Neapolitan',
  'vera pizza': 'Neapolitan',
  'margherita': 'Neapolitan',

  // Sicilian
  'sicilian': 'Sicilian',
  'sicily': 'Sicilian',
  'grandma': 'Grandma',
  'grandma style': 'Grandma',
  'grandma pizza': 'Grandma',

  // Roman
  'roman': 'Roman',
  'al taglio': 'Roman',
  'pizza al taglio': 'Roman',

  // St. Louis
  'st. louis': 'St. Louis',
  'st louis': 'St. Louis',
  'st-louis': 'St. Louis',

  // Tavern (Chicago thin)
  'tavern': 'Tavern',
  'tavern style': 'Tavern',
  'party cut': 'Tavern',
  'square cut': 'Tavern',
}

// Chain name to price mappings
const CHAIN_PRICE_MAP = {
  // Budget ($)
  "little caesars": '$',
  "little caesar's": '$',
  "domino's": '$',
  "dominos": '$',
  "hungry howie's": '$',
  "hungry howies": '$',
  "cici's": '$',
  "cicis pizza": '$',
  "papa murphy's": '$',
  "b.c. pizza": '$$',
  "bc pizza": '$$',
  "best choice pizza": '$$',

  // Moderate ($$)
  "pizza hut": '$$',
  "papa john's": '$$',
  "papa johns": '$$',
  "fox's pizza": '$$',
  "foxs pizza": '$$',
  "pizza ranch": '$$',
  "round table": '$$',
  "round table pizza": '$$',
  "simple simon's": '$$',
  "simple simons": '$$',
  "simple simon's pizza": '$$',
  "simple simons pizza": '$$',
  "jet's": '$$',
  "jets": '$$',
  "jets pizza": '$$',
  "buddy's": '$$',
  "buddy's pizza": '$$',
  "blaze pizza": '$$',
  "mod pizza": '$$',
  "marco's": '$$',
  "marcos pizza": '$$',
  "cottage inn": '$$',
  "mancino's": '$$',
  "sbarro": '$$',
  "chuck e. cheese": '$$',
  "toppers pizza": '$$',
  "donatos": '$$',
  "pieology": '$$',
  "&pizza": '$$',
  "larosa's": '$$',
  "larosas": '$$',
  "larosa's pizzeria": '$$',
  "larosas pizzeria": '$$',
  "sal's pizza": '$$',
  "sals pizza": '$$',
  "shield's": '$$',
  "toarmina's": '$$',

  // Expensive ($$$)
  "lou malnati's": '$$$',
  "giordano's": '$$$',
  "uno pizzeria": '$$$',
}

/**
 * Normalize restaurant name for matching
 */
function normalizeName(name) {
  if (!name) return ''
  return name
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Infer pizza style from restaurant name
 */
export function inferStyleFromName(name, address = '') {
  const normalized = normalizeName(name)
  const normalizedAddress = normalizeName(address)

  // Check exact chain matches first
  for (const [chain, style] of Object.entries(CHAIN_STYLE_MAP)) {
    if (normalized === chain || normalized.startsWith(chain + ' ') || normalized.includes(chain)) {
      return {
        style: normalizePizzaStyle(style),
        confidence: 'high',
        source: 'chain_map',
        match: chain,
      }
    }
  }

  // Check style keywords in name
  for (const [keyword, style] of Object.entries(STYLE_KEYWORDS)) {
    if (normalized.includes(keyword)) {
      return {
        style: normalizePizzaStyle(style),
        confidence: 'medium',
        source: 'keyword',
        match: keyword,
      }
    }
  }

  // Check style keywords in address (less confident)
  for (const [keyword, style] of Object.entries(STYLE_KEYWORDS)) {
    if (normalizedAddress.includes(keyword)) {
      return {
        style: normalizePizzaStyle(style),
        confidence: 'low',
        source: 'address_keyword',
        match: keyword,
      }
    }
  }

  // No match found
  return {
    style: null,
    confidence: null,
    source: null,
    match: null,
  }
}

/**
 * Infer a primary pizza style from a verified OSM brand or operator Wikidata ID.
 */
export function inferStyleFromBrandWikidata(wikidataId) {
  const id = String(wikidataId || '').trim()
  const style = WIKIDATA_BRAND_STYLE_MAP[id]
  return {
    style: style ? normalizePizzaStyle(style) : null,
    confidence: style ? 'high' : null,
    source: style ? 'brand_wikidata_map' : null,
    match: style ? id : null,
  }
}

/**
 * Infer price from chain name
 */
export function inferPriceFromChain(name) {
  const normalized = normalizeName(name)

  for (const [chain, price] of Object.entries(CHAIN_PRICE_MAP)) {
    if (normalized === chain || normalized.startsWith(chain + ' ') || normalized.includes(chain)) {
      return {
        price,
        confidence: 'high',
        source: 'chain_map',
        match: chain,
      }
    }
  }

  return {
    price: null,
    confidence: null,
    source: null,
    match: null,
  }
}

/**
 * Check if name matches a known chain
 */
export function isKnownChain(name) {
  const normalized = normalizeName(name)
  const allChains = new Set([
    ...Object.keys(CHAIN_STYLE_MAP),
    ...Object.keys(CHAIN_PRICE_MAP),
  ])

  for (const chain of allChains) {
    if (normalized.includes(chain)) {
      return true
    }
  }
  return false
}

/**
 * Infer style from Yelp categories
 */
export function inferStyleFromCategories(categories = []) {
  const categoryStr = categories.join(' ').toLowerCase()

  if (categoryStr.includes('detroit')) return { style: 'Detroit', confidence: 'medium', source: 'yelp_category' }
  if (categoryStr.includes('new haven') || categoryStr.includes('connecticut')) return { style: 'New Haven / Connecticut', confidence: 'medium', source: 'yelp_category' }
  if (categoryStr.includes('chicago') || categoryStr.includes('deep dish')) return { style: 'Chicago Deep Dish', confidence: 'medium', source: 'yelp_category' }
  if (categoryStr.includes('neapolitan') || categoryStr.includes('wood-fired')) return { style: 'Neapolitan', confidence: 'medium', source: 'yelp_category' }
  if (categoryStr.includes('new york') || categoryStr.includes('ny style')) return { style: 'New York', confidence: 'medium', source: 'yelp_category' }
  if (categoryStr.includes('sicilian')) return { style: 'Sicilian', confidence: 'medium', source: 'yelp_category' }
  if (categoryStr.includes('grandma')) return { style: 'Grandma', confidence: 'medium', source: 'yelp_category' }

  return { style: null, confidence: null, source: null }
}
