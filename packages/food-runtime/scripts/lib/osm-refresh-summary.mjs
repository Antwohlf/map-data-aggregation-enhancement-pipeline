export function summarizeOsmManifest(manifest = {}, { refreshAfterHours = 720, now = Date.now() } = {}) {
  const tiles = Object.values(manifest.tiles || {})
  const tileStatuses = tiles.reduce((counts, tile) => {
    const status = String(tile?.status || 'unprocessed')
    counts[status] = (counts[status] || 0) + 1
    return counts
  }, {})
  const statuses = tiles.length ? tileStatuses : { ...(manifest.statuses || {}) }
  const tileCount = Number(manifest.total_tiles || tiles.length || 0)
  const refreshAfterMs = Number(refreshAfterHours) * 60 * 60 * 1000
  const staleTiles = tiles.filter(tile => (
    tile?.status === 'success'
    && (!tile.completed_at
      || !Number.isFinite(Date.parse(tile.completed_at))
      || now - Date.parse(tile.completed_at) >= refreshAfterMs)
  )).length
  const failedTiles = Number(statuses.failed || 0)
  const partialTiles = Number(statuses.partial || 0)
  const processedTiles = Number(statuses.success || 0) + partialTiles + failedTiles
  const unprocessedTiles = Math.max(tileCount - processedTiles, 0)
  const retryableTiles = failedTiles + partialTiles

  return {
    tileCount,
    statuses,
    staleTiles,
    failedTiles,
    partialTiles,
    unprocessedTiles,
    retryableTiles,
    refreshQueueTiles: unprocessedTiles + retryableTiles + staleTiles,
  }
}
