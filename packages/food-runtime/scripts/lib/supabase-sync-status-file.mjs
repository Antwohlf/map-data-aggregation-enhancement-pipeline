export function defaultSyncStatusFile(entity = 'pizza') {
  const normalized = String(entity || 'pizza').trim().toLowerCase()
  return normalized === 'pizza'
    ? 'scripts/.supabase-sync-status.json'
    : `scripts/.${normalized}-supabase-sync-status.json`
}
