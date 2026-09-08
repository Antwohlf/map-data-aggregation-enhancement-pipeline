/**
 * Type and price inference for taco places from restaurant names
 * Matches known chains and protein keywords to populate the 'type' field
 */

// Chain name to type/price mappings
// Types stored as arrays since most places serve multiple proteins
const CHAIN_TYPE_MAP = {
  // Fast food chains - ground beef/chicken focus
  'taco bell': { types: ['Ground Beef', 'Pollo'], price: '$' },
  'del taco': { types: ['Ground Beef', 'Pollo', 'Carne Asada'], price: '$' },
  'taco cabana': { types: ['Pollo', 'Carne Asada', 'Carnitas'], price: '$' },
  "taco john's": { types: ['Ground Beef', 'Pollo'], price: '$' },
  'taco johns': { types: ['Ground Beef', 'Pollo'], price: '$' },
  'taco bueno': { types: ['Ground Beef', 'Pollo'], price: '$' },
  'taco casa': { types: ['Ground Beef', 'Pollo'], price: '$' },
  'taco mayo': { types: ['Ground Beef', 'Pollo'], price: '$' },
  'taco time': { types: ['Ground Beef', 'Pollo'], price: '$' },
  'jimboy\'s tacos': { types: ['Ground Beef'], price: '$' },
  'jimboys tacos': { types: ['Ground Beef'], price: '$' },
  'jack in the box': { types: ['Ground Beef'], price: '$' },

  // Chicken-focused chains
  'el pollo loco': { types: ['Pollo', 'Carne Asada'], price: '$' },

  // Fast casual
  "rubio's": { types: ['Fish', 'Shrimp'], price: '$$' },
  'rubios': { types: ['Fish', 'Shrimp'], price: '$$' },
  "rubio's coastal grill": { types: ['Fish', 'Shrimp'], price: '$$' },
  'chronic tacos': { types: ['Carne Asada', 'Al Pastor', 'Carnitas'], price: '$$' },
  "fuzzy's taco shop": { types: ['Ground Beef', 'Pollo', 'Fish'], price: '$$' },
  'fuzzys taco shop': { types: ['Ground Beef', 'Pollo', 'Fish'], price: '$$' },
  "torchy's tacos": { types: ['Carne Asada', 'Pollo', 'Fish'], price: '$$' },
  'torchys tacos': { types: ['Carne Asada', 'Pollo', 'Fish'], price: '$$' },
  'velvet taco': { types: ['Carne Asada', 'Pollo'], price: '$$' },
  'bartaco': { types: ['Carne Asada', 'Pollo', 'Fish'], price: '$$' },
  'tacodeli': { types: ['Carne Asada', 'Pollo', 'Barbacoa'], price: '$$' },
  'taco republic': { types: ['Al Pastor', 'Carne Asada', 'Carnitas'], price: '$$' },

  // Regional Mexican chains
  'taco palenque': { types: ['Carne Asada', 'Al Pastor', 'Barbacoa'], price: '$' },
  'taqueria arandas': { types: ['Al Pastor', 'Carnitas', 'Carne Asada'], price: '$' },
  'taqueria datapoint': { types: ['Al Pastor', 'Carnitas'], price: '$' },
  'king taco': { types: ['Al Pastor', 'Carne Asada'], price: '$' },
  'los tacos no.': { types: ['Al Pastor', 'Carne Asada'], price: '$' },
  'tacos el gordo': { types: ['Al Pastor', 'Carne Asada', 'Lengua'], price: '$' },
  'tacos gavilan': { types: ['Carne Asada', 'Al Pastor'], price: '$' },

  // Birria specialists
  'birrieria': { types: ['Birria'], price: '$' },
  'la birria': { types: ['Birria'], price: '$' },
  'birria don boni': { types: ['Birria'], price: '$' },
  'birria landia': { types: ['Birria'], price: '$' },

  // Seafood specialists
  'mariscos': { types: ['Shrimp', 'Fish'], price: '$$' },
  'el torito mariscos': { types: ['Shrimp', 'Fish'], price: '$$' },
  'tacos de mariscos': { types: ['Shrimp', 'Fish'], price: '$$' },
}

// Protein keywords that suggest specific taco types
// Maps keyword to canonical type name
const PROTEIN_KEYWORDS = {
  // Birria
  'birria': 'Birria',
  'birrieria': 'Birria',
  'quesabirria': 'Birria',

  // Al Pastor
  'pastor': 'Al Pastor',
  'al pastor': 'Al Pastor',
  'adobada': 'Al Pastor',

  // Carne Asada
  'asada': 'Carne Asada',
  'carne asada': 'Carne Asada',

  // Carnitas
  'carnitas': 'Carnitas',

  // Chicken
  'pollo': 'Pollo',
  'chicken': 'Pollo',

  // Barbacoa
  'barbacoa': 'Barbacoa',

  // Lengua
  'lengua': 'Lengua',

  // Cabeza
  'cabeza': 'Cabeza',

  // Chorizo
  'chorizo': 'Chorizo',

  // Fish
  'pescado': 'Fish',
  'fish taco': 'Fish',
  'baja': 'Fish', // Baja style often implies fish tacos

  // Shrimp
  'camarones': 'Shrimp',
  'shrimp': 'Shrimp',
  'mariscos': 'Shrimp',
}

// Chain name to price mappings (for chains not in CHAIN_TYPE_MAP)
const CHAIN_PRICE_MAP = {
  // Budget ($)
  'taco bell': '$',
  'del taco': '$',
  'taco bueno': '$',
  "taco john's": '$',
  'taco johns': '$',
  'taco cabana': '$',
  'taco casa': '$',
  'taco mayo': '$',
  'taco time': '$',
  'taco palenque': '$',
  'king taco': '$',
  'tacos el gordo': '$',

  // Moderate ($$)
  "rubio's": '$$',
  'rubios': '$$',
  'chronic tacos': '$$',
  "fuzzy's taco shop": '$$',
  'fuzzys taco shop': '$$',
  "torchy's tacos": '$$',
  'torchys tacos': '$$',
  'velvet taco': '$$',
  'bartaco': '$$',
  'tacodeli': '$$',

  // Expensive ($$$)
  'wahoo\'s fish taco': '$$$',
  'wahoos fish taco': '$$$',
}

/**
 * Normalize restaurant name for matching
 */
export function normalizeName(name) {
  if (!name) return ''
  return name
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Infer taco types from restaurant name
 * Returns types as an array since many places serve multiple proteins
 */
export function inferTypeFromName(name, address = '') {
  const normalized = normalizeName(name)
  const normalizedAddress = normalizeName(address)

  // Check exact chain matches first
  for (const [chain, data] of Object.entries(CHAIN_TYPE_MAP)) {
    if (normalized === chain || normalized.startsWith(chain + ' ') || normalized.includes(chain)) {
      return {
        types: data.types,
        confidence: 'high',
        source: 'chain_map',
        match: chain,
        price: data.price,
      }
    }
  }

  // Check protein keywords in name - can match multiple
  const foundTypes = []
  let matchedKeyword = null

  for (const [keyword, type] of Object.entries(PROTEIN_KEYWORDS)) {
    if (normalized.includes(keyword)) {
      if (!foundTypes.includes(type)) {
        foundTypes.push(type)
        if (!matchedKeyword) matchedKeyword = keyword
      }
    }
  }

  if (foundTypes.length > 0) {
    return {
      types: foundTypes,
      confidence: 'medium',
      source: 'keyword',
      match: matchedKeyword,
      price: null,
    }
  }

  // Check keywords in address (less confident)
  for (const [keyword, type] of Object.entries(PROTEIN_KEYWORDS)) {
    if (normalizedAddress.includes(keyword)) {
      return {
        types: [type],
        confidence: 'low',
        source: 'address_keyword',
        match: keyword,
        price: null,
      }
    }
  }

  // No match found
  return {
    types: null,
    confidence: null,
    source: null,
    match: null,
    price: null,
  }
}

/**
 * Infer price from chain name
 */
export function inferPriceFromChain(name) {
  const normalized = normalizeName(name)

  // First check CHAIN_TYPE_MAP for price
  for (const [chain, data] of Object.entries(CHAIN_TYPE_MAP)) {
    if (normalized === chain || normalized.startsWith(chain + ' ') || normalized.includes(chain)) {
      return {
        price: data.price,
        confidence: 'high',
        source: 'chain_map',
        match: chain,
      }
    }
  }

  // Then check CHAIN_PRICE_MAP
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
    ...Object.keys(CHAIN_TYPE_MAP),
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
 * Infer type from Yelp categories
 */
export function inferTypeFromCategories(categories = []) {
  const categoryStr = categories.join(' ').toLowerCase()

  const foundTypes = []

  if (categoryStr.includes('birria')) foundTypes.push('Birria')
  if (categoryStr.includes('seafood') || categoryStr.includes('fish') || categoryStr.includes('mariscos')) {
    foundTypes.push('Fish')
    foundTypes.push('Shrimp')
  }
  if (categoryStr.includes('tacos al pastor') || categoryStr.includes('pastor')) foundTypes.push('Al Pastor')
  if (categoryStr.includes('street taco')) foundTypes.push('Carne Asada')
  if (categoryStr.includes('carnitas')) foundTypes.push('Carnitas')

  if (foundTypes.length > 0) {
    return { types: foundTypes, confidence: 'medium', source: 'yelp_category' }
  }

  return { types: null, confidence: null, source: null }
}

/**
 * Format types array as comma-separated string for storage
 */
export function formatTypesForStorage(types) {
  if (!types || types.length === 0) return null
  return types.join(', ')
}
