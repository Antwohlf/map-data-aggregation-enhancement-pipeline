export const STYLE_EVIDENCE = {
  Detroit: ['detroit'],
  'New Haven / Connecticut': ['new haven', 'connecticut', 'apizza'],
  'Chicago Deep Dish': ['chicago', 'deep dish', 'deep-dish', 'stuffed'],
  'Chicago Tavern': ['chicago tavern', 'chicago thin'],
  'New York': ['new york', 'ny style', 'ny-style', 'brooklyn'],
  Neapolitan: ['neapolitan', 'wood fired', 'wood-fired', 'brick oven', 'coal fired', 'napoletana', 'napoli'],
  Sicilian: ['sicilian'],
  Grandma: ['grandma'],
  Roman: ['roman', 'al taglio', 'taglio'],
  'St. Louis': ['st. louis', 'st louis', 'st-louis'],
  Tavern: ['tavern', 'party cut', 'thin crust', 'square cut'],
  California: ['california'],
  'Standard Round': ['pizza', 'pizzeria', 'pizzaria', 'pizzería', 'pizzas', 'domino', 'pizza hut', 'papa john', 'little caesars', 'sbarro'],
  Other: [],
  Unknown: []
}

export const PIZZA_SIGNAL_TERMS = [
  'pizza',
  'pizzeria',
  'pizzaria',
  'pizzería',
  'pizzas',
  'pizz',
  'slice',
  'slices',
  'pie',
  'cuisine":"pizza',
  'cuisine:pizza',
  'italian'
]

export function toEvidenceText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function evidenceText(row) {
  return [
    row.name,
    row.website_url,
    toEvidenceText(row.osm_tags),
    toEvidenceText(row.scrape_notes),
    // Accepted source evidence is already part of the classifier's input
    // contract. Include it in the final guardrail too, otherwise a valid
    // source-backed style can be discarded after the model responds.
    toEvidenceText(row.source_evidence)
  ].filter(Boolean).join(' ').toLowerCase()
}

export function hasAnyEvidence(text, terms) {
  return terms.some(term => text.includes(term))
}

export function hasStyleEvidence(row, style = row.style) {
  if (!style) return true
  if (style === 'Other' || style === 'Unknown') return true
  const terms = STYLE_EVIDENCE[style] || []
  return terms.length ? hasAnyEvidence(evidenceText(row), terms) : false
}

export function hasPizzaSignal(row) {
  return hasAnyEvidence(evidenceText(row), PIZZA_SIGNAL_TERMS)
}
