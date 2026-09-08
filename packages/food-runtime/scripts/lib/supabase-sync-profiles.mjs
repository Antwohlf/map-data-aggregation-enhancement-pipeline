// Entity-specific publication settings. Disabled entities are available for
// dry-run planning without allowing an accidental public write.
export const SUPABASE_SYNC_PROFILES = Object.freeze({
  pizza: Object.freeze({
    entity: 'pizza',
    targetTable: 'pizza_places',
    bulkRpc: 'apply_pizza_places_sync_batch',
    publicationEnabled: true,
  }),
  taco: Object.freeze({
    entity: 'taco',
    targetTable: 'taco_places',
    bulkRpc: 'apply_taco_places_sync_batch',
    publicationEnabled: true,
  }),
});

export const SUPABASE_SYNCABLE_TABLES = Object.freeze(
  Object.values(SUPABASE_SYNC_PROFILES).map(profile => profile.targetTable),
);

export function supabaseSyncProfile(entity = 'pizza') {
  const key = String(entity || 'pizza').trim().toLowerCase();
  const profile = SUPABASE_SYNC_PROFILES[key];
  if (!profile) throw new Error(`Unsupported sync entity: ${entity}`);
  return profile;
}

export function syncTargetForEntity(entity = 'pizza') {
  return supabaseSyncProfile(entity).targetTable;
}

export function syncRpcForEntity(entity = 'pizza') {
  return supabaseSyncProfile(entity).bulkRpc;
}
