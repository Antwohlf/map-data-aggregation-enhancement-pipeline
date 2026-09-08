/**
 * Resolve the regions a source-pipeline run is allowed to operate on.
 *
 * `regions` describes the configured geographic catalog. `operational_regions`
 * is the smaller production scope. An explicit CLI region list is an
 * intentional override and may select any configured region.
 */
export function selectSourcePipelineRegions(config, requestedRegions = null) {
  const configuredRegions = Array.isArray(config?.regions) ? config.regions : []
  const configuredByKey = new Map(
    configuredRegions.map(region => [String(region?.key || '').trim().toUpperCase(), region]),
  )
  const requested = Array.isArray(requestedRegions) && requestedRegions.length
    ? requestedRegions
    : (Array.isArray(config?.operational_regions) && config.operational_regions.length
      ? config.operational_regions
      : configuredRegions.map(region => region?.key))

  return [...new Set(requested
    .map(value => String(value || '').trim().toUpperCase())
    .filter(Boolean))]
    .map(key => configuredByKey.get(key))
    .filter(Boolean)
}
