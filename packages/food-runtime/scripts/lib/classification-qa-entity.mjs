import { enrichmentEntity } from './enrichment-entity.mjs'

export function classificationQaProfile(entity) {
  const profile = enrichmentEntity(entity)
  return Object.freeze({
    entity: profile.entity,
    table: profile.table,
    taxonomy: profile.taxonomy,
  })
}

export function validClassificationStyle(value, entity) {
  if (value === null) return true
  const profile = classificationQaProfile(entity)
  const taxonomy = new Set([...profile.taxonomy, 'Unknown'])
  const values = profile.entity === 'taco'
    ? String(value).split(',').map(item => item.trim()).filter(Boolean)
    : [value]
  return values.length > 0 && values.every(item => taxonomy.has(item))
}
