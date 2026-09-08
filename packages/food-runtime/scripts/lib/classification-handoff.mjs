import { enrichmentEntity } from './enrichment-entity.mjs'

export function enqueueClassificationHandoff(queue, job, {
  state = null,
  style = null,
  priceRange = null,
} = {}) {
  const entity = enrichmentEntity(job?.placeType).entity
  if (style !== null || priceRange !== null) return false
  return queue.addJob('classify', job.osmId, entity, { state })
}
