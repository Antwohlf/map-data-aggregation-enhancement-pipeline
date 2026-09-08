/**
 * Priority Calculation for Enrichment Pipeline
 *
 * Determines processing order based on geographic location.
 * Higher priority = processed first.
 *
 * Priority Levels:
 *   100  - Michigan (home state)
 *   95   - Major US states (NY, CA, TX, FL, IL, etc.)
 *   80   - Other US states
 *   60   - Canada
 *   55   - Mexico
 *   50   - Europe
 *   40   - Latin America
 *   30   - Rest of world
 */

// US state codes (2-letter)
export const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC'  // Washington DC
])

// Major US states (high pizza/taco density)
export const MAJOR_US_STATES = new Set([
  'NY', 'CA', 'TX', 'FL', 'IL', 'PA', 'OH', 'GA', 'NC', 'NJ',
  'VA', 'WA', 'AZ', 'MA', 'TN', 'IN', 'MO', 'MD', 'WI', 'CO',
  'MN', 'SC', 'AL', 'LA', 'KY', 'OR', 'OK', 'CT', 'UT', 'NV'
])

// Canadian province codes
export const CANADIAN_PROVINCES = new Set([
  'ON', 'QC', 'BC', 'AB', 'MB', 'SK', 'NS', 'NB', 'NL', 'PE',
  'NT', 'YT', 'NU'
])

// European country codes (2-letter ISO)
export const EUROPEAN_COUNTRIES = new Set([
  'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'AT', 'CH', 'PT',
  'IE', 'DK', 'SE', 'NO', 'FI', 'PL', 'CZ', 'GR', 'HU', 'RO',
  'BG', 'HR', 'SK', 'SI', 'LT', 'LV', 'EE', 'LU', 'MT', 'CY'
])

// Latin American country codes (3-letter for disambiguation)
export const LATIN_AMERICAN_COUNTRIES = new Set([
  'MEX', 'BRA', 'ARG', 'COL', 'PER', 'VEN', 'CHL', 'ECU', 'GTM',
  'CUB', 'DOM', 'BOL', 'HND', 'SLV', 'PRY', 'NIC', 'CRI', 'PAN',
  'URY', 'JAM', 'TTO', 'PRI'
])

// Priority levels
export const PRIORITY = {
  MICHIGAN: 100,
  MAJOR_US: 95,
  OTHER_US: 80,
  CANADA: 60,
  MEXICO: 55,
  EUROPE: 50,
  LATIN_AMERICA: 40,
  DEFAULT: 30
}

/**
 * Calculate priority for a place based on its state/region code
 *
 * @param {string} state - State/region code (2 or 3 letter)
 * @param {string} country - Optional country code
 * @returns {number} Priority value (higher = process first)
 */
export function calculatePriority(state, country = null) {
  if (!state) return PRIORITY.DEFAULT

  const upperState = state.toUpperCase()

  // Michigan is always top priority
  if (upperState === 'MI') {
    return PRIORITY.MICHIGAN
  }

  // Major US states
  if (MAJOR_US_STATES.has(upperState)) {
    return PRIORITY.MAJOR_US
  }

  // Other US states
  if (US_STATES.has(upperState)) {
    return PRIORITY.OTHER_US
  }

  // Canada (if state looks like a province or country is CA)
  if (CANADIAN_PROVINCES.has(upperState) || country === 'CA') {
    return PRIORITY.CANADA
  }

  // Mexico
  if (country === 'MX' || upperState === 'MX' || upperState === 'MEX') {
    return PRIORITY.MEXICO
  }

  // Europe
  if (EUROPEAN_COUNTRIES.has(upperState)) {
    return PRIORITY.EUROPE
  }

  // Latin America (using 3-letter codes)
  if (LATIN_AMERICAN_COUNTRIES.has(upperState)) {
    return PRIORITY.LATIN_AMERICA
  }

  return PRIORITY.DEFAULT
}

/**
 * Get priority group name for display
 */
export function getPriorityGroup(priority) {
  if (priority >= PRIORITY.MICHIGAN) return 'michigan'
  if (priority >= PRIORITY.MAJOR_US) return 'major_us'
  if (priority >= PRIORITY.OTHER_US) return 'other_us'
  if (priority >= PRIORITY.CANADA) return 'canada'
  if (priority >= PRIORITY.MEXICO) return 'mexico'
  if (priority >= PRIORITY.EUROPE) return 'europe'
  if (priority >= PRIORITY.LATIN_AMERICA) return 'latin_america'
  return 'rest_of_world'
}

/**
 * Sort places by priority (descending)
 */
export function sortByPriority(places) {
  return [...places].sort((a, b) => {
    const priorityA = calculatePriority(a.state, a.country)
    const priorityB = calculatePriority(b.state, b.country)
    return priorityB - priorityA  // Higher priority first
  })
}

/**
 * Group places by priority level
 */
export function groupByPriority(places) {
  const groups = {
    michigan: [],
    major_us: [],
    other_us: [],
    canada: [],
    mexico: [],
    europe: [],
    latin_america: [],
    rest_of_world: []
  }

  for (const place of places) {
    const priority = calculatePriority(place.state, place.country)
    const group = getPriorityGroup(priority)
    groups[group].push(place)
  }

  return groups
}

// CLI for testing
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('=== Priority Calculation Test ===\n')

  const testCases = [
    { state: 'MI', expected: 100 },
    { state: 'NY', expected: 95 },
    { state: 'WY', expected: 80 },
    { state: 'ON', expected: 60 },
    { state: 'MX', expected: 55 },
    { state: 'DE', expected: 50 },  // Germany
    { state: 'MEX', expected: 40 }, // Mexico (3-letter)
    { state: 'JP', expected: 30 },  // Japan
    { state: null, expected: 30 }
  ]

  console.log('State -> Priority')
  console.log('-'.repeat(30))

  for (const test of testCases) {
    const actual = calculatePriority(test.state)
    const pass = actual === test.expected ? '✓' : '✗'
    console.log(`${pass} ${test.state || 'null'} -> ${actual} (expected ${test.expected})`)
  }

  console.log('\n=== Priority Groups ===')
  console.log(PRIORITY)
}
