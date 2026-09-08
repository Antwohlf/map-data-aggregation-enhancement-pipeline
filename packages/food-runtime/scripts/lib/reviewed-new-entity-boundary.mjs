export const REVIEWED_NEW_ENTITY_TARGETS = Object.freeze({
  pizza: Object.freeze({ canonicalTable: 'pizza_places' }),
  taco: Object.freeze({ canonicalTable: 'taco_places' }),
})

export function reviewedNewTarget(entity) {
  const target = REVIEWED_NEW_ENTITY_TARGETS[String(entity || '').trim().toLowerCase()]
  if (!target) throw new Error(`Unsupported reviewed-new entity: ${entity}`)
  return target
}

export function guardedPublishArgs(entity, placeIds) {
  reviewedNewTarget(entity)
  if (!Array.isArray(placeIds) || !placeIds.length || placeIds.some(id => !Number.isInteger(Number(id)) || Number(id) <= 0)) {
    throw new Error('Guarded publish requires positive place IDs')
  }
  return [
    'scripts/ops/guarded-supabase-sync.mjs',
    '--entity', entity,
    '--ids', placeIds.join(','),
    '--batch', String(placeIds.length),
    '--max-batches', '1',
    '--insert-missing-reviewed-new',
    '--apply',
  ]
}
