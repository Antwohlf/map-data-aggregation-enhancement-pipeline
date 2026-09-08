import { PIZZA_STYLES } from './pizza-style-taxonomy.mjs'

const TACO_TYPES = [
  'Al Pastor', 'Carne Asada', 'Carnitas', 'Chorizo', 'Pollo', 'Barbacoa',
  'Birria', 'Lengua', 'Fish', 'Shrimp', 'Ground Beef', 'Cabeza', 'Veggie',
]

export const ENRICHMENT_ENTITIES = Object.freeze({
  pizza: Object.freeze({
    entity: 'pizza',
    table: 'pizza_places',
    taxonomyLabel: 'pizza style',
    taxonomy: PIZZA_STYLES,
    sourceEvidenceEntity: 'pizza',
  }),
  taco: Object.freeze({
    entity: 'taco',
    table: 'taco_places',
    taxonomyLabel: 'primary taco type',
    taxonomy: Object.freeze([...TACO_TYPES]),
    sourceEvidenceEntity: 'taco',
  }),
})

export function enrichmentEntity(value = 'pizza') {
  const entity = String(value || 'pizza').trim().toLowerCase()
  const profile = ENRICHMENT_ENTITIES[entity]
  if (!profile) throw new Error(`Unsupported enrichment entity: ${value}`)
  return profile
}

export function enrichmentTable(value = 'pizza') {
  return enrichmentEntity(value).table
}

export function taxonomyForEntity(value = 'pizza') {
  return enrichmentEntity(value).taxonomy
}

export function normalizeEnrichmentStyle(value, entity = 'pizza') {
  const raw = String(value || '').trim()
  if (!raw) return null
  const profile = enrichmentEntity(entity)
  const normalized = raw.toLocaleLowerCase('en-US')
  return profile.taxonomy.find(option => option.toLocaleLowerCase('en-US') === normalized) || 'Unknown'
}
