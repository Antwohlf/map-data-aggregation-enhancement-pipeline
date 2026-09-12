import { SUPABASE_SYNCABLE_TABLES, supabaseSyncProfile } from './supabase-sync-profiles.mjs';
import { assertSupabasePlaceIdentity } from './supabase-sync-identity.mjs';

const DEFAULT_SYNC_PROFILE = supabaseSyncProfile();

export const SUPABASE_SYNC_TARGET_TABLE = DEFAULT_SYNC_PROFILE.targetTable;
export const SUPABASE_BULK_SYNC_RPC = DEFAULT_SYNC_PROFILE.bulkRpc;

// The public schema stores compact region codes. Keep the full source address
// intact, but map the one current international subdivision that exceeds the
// public column width before inserting a new canonical row.
export const SUPABASE_STATE_ALIASES = Object.freeze({
  'new providence': 'NP',
});

export function normalizeSupabaseState(value) {
  if (value === null || value === undefined) return value;
  const state = String(value).trim();
  if (state.length <= 10) return state;
  const normalized = SUPABASE_STATE_ALIASES[state.toLowerCase()];
  if (normalized) return normalized;
  throw new Error(`State value exceeds Supabase's 10-character limit and has no mapping: ${state}`);
}

// Lifecycle is an explicit editorial decision, so keep it out of the normal
// sync contract until the matching Supabase columns have been migrated.
export const LIFECYCLE_SYNC_ENABLED = /^(1|true|yes)$/i.test(
  String(process.env.ENABLE_LIFECYCLE_SYNC || '').trim(),
);
export const LIFECYCLE_COLS = LIFECYCLE_SYNC_ENABLED
  ? ['lifecycle_status', 'lifecycle_replaced_by_id']
  : [];

export const LOCAL_ONLY_SUPABASE_TABLES = [
  'place_sources',
  'source_review_queue',
];

export const OVERWRITE_COLS = [
  'created_at',
  'updated_at',
  'enrichment_status',
  'last_enriched_at',
  'enrichment_agent',
  'enrichment_run_id',
  'address_source',
  'website_url',
  'menu_url',
  'phone',
  'email',
  'instagram_url',
  'facebook_url',
  'twitter_url',
  'whatsapp',
  'hours',
  'scrape_method',
  'scrape_notes',
  'delivery',
  'takeaway',
  'drive_through',
  'outdoor_seating',
  'indoor_seating',
  'wheelchair',
  'brand',
  'brand_wikidata',
  'operator',
  'operator_wikidata',
  'osm_tags',
  'osm_last_fetched_at',
  'osm_fetch_status',
  'osm_fetch_error',
  'menu_data',
  'menu_parse_confidence',
  'menu_parse_notes',
  'menu_last_parsed_at',
];

// These are canonical classification values produced by the local database.
// Source adapters are still prohibited from promoting them directly, but the
// local canonical row is authoritative when mirroring to the public table.
export const CANONICAL_MIRROR_COLS = [
  'style',
  'price',
  'price_range',
  'style_confidence',
];

export const QA_DEFAULT_COLS = [
  'qa_status',
  'qa_schema_version',
];

export const LOCAL_CONTEXT_COLS = [
  'id',
  'name',
  'lat',
  'lng',
  'address',
  'state',
  'google_place_id',
  'status',
];

export const LOCAL_SYNC_COLS = [
  ...LOCAL_CONTEXT_COLS,
  ...CANONICAL_MIRROR_COLS,
  ...OVERWRITE_COLS,
  ...LIFECYCLE_COLS,
];

export const ENTITY_EXCLUDED_SYNC_COLS = Object.freeze({
  taco: Object.freeze([
    'created_at',
    'menu_data', 'menu_parse_confidence', 'menu_parse_notes', 'menu_last_parsed_at',
    'qa_status', 'qa_schema_version',
  ]),
});

export function syncColumnsForEntity(columns, entity = 'pizza') {
  const excluded = new Set(ENTITY_EXCLUDED_SYNC_COLS[String(entity || 'pizza').toLowerCase()] || []);
  return columns.filter(column => !excluded.has(column));
}

const LOCAL_SYNC_CHECKPOINT_COL = `to_char(last_enriched_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as sync_checkpoint_last_enriched_at`;

export const SUPABASE_SYNC_SELECT_COLS = [
  ...LOCAL_CONTEXT_COLS,
  ...OVERWRITE_COLS,
  ...CANONICAL_MIRROR_COLS,
  ...QA_DEFAULT_COLS,
  ...LIFECYCLE_COLS,
];

export const LOCAL_SYNC_VALUE_COLS = [
  ...CANONICAL_MIRROR_COLS,
  ...OVERWRITE_COLS,
  ...LIFECYCLE_COLS,
];

export function supabaseSyncSelectCols(entity = 'pizza') {
  return syncColumnsForEntity(SUPABASE_SYNC_SELECT_COLS, entity);
}

export function assertSupabaseSyncTableBoundary({
  entity = null,
  targetTable = entity ? supabaseSyncProfile(entity).targetTable : SUPABASE_SYNC_TARGET_TABLE,
  localOnlyTables = LOCAL_ONLY_SUPABASE_TABLES,
} = {}) {
  if (localOnlyTables.includes(targetTable)) {
    throw new Error(`Refusing to sync local-only provenance/review table to Supabase: ${targetTable}`);
  }

  if (!SUPABASE_SYNCABLE_TABLES.includes(targetTable)) {
    throw new Error(`Unsupported Supabase sync target table: ${targetTable}`);
  }

  if (entity && supabaseSyncProfile(entity).targetTable !== targetTable) {
    throw new Error(`Sync entity ${entity} does not use target table ${targetTable}`);
  }

  return {
    targetTable,
    localOnlyTables: [...localOnlyTables],
  };
}

export function normalizeSyncSelectorOptions(options = {}) {
  const checkpointAfter = options.checkpointAfter || null;
  const checkpointMode = Boolean(options.checkpointMode || checkpointAfter);
  const ids = Array.isArray(options.ids)
    ? [...new Set(options.ids.map(id => Number(id)).filter(id => Number.isInteger(id) && id > 0))]
    : [];

  return {
    ids,
    lifecycleOnly: Boolean(options.lifecycleOnly),
    startAfter: Number.isFinite(options.startAfter) ? options.startAfter : 0,
    batch: Math.max(
      Number.isFinite(options.batch) && options.batch > 0 ? options.batch : 500,
      ids.length || 0,
    ),
    changedSinceHours: options.changedSinceHours ?? null,
    onlyClassified: Boolean(options.onlyClassified),
    reconcile: Boolean(options.reconcile),
    checkpointMode: ids.length ? false : checkpointMode,
    checkpointAfter: ids.length ? null : checkpointAfter,
  };
}

export function localSyncSelect(options = {}) {
  const selector = normalizeSyncSelectorOptions(options);
  const targetTable = options.targetTable || (options.entity
    ? supabaseSyncProfile(options.entity).targetTable
    : SUPABASE_SYNC_TARGET_TABLE);
  assertSupabaseSyncTableBoundary({ entity: options.entity || null, targetTable });
  const params = [];
  const entity = options.entity || 'pizza';
  const valueCols = selector.lifecycleOnly ? LIFECYCLE_COLS : syncColumnsForEntity(LOCAL_SYNC_VALUE_COLS, entity);
  const filters = [
    `(
            ${valueCols.map(col => `${col} is not null`).join('\n            or ')}
          )`,
  ];

  if (selector.ids.length) {
    params.push(selector.ids);
    filters.unshift(`id = ANY($${params.length}::int[])`);
  } else if (selector.reconcile) {
    params.push(selector.checkpointAfter?.lastId ?? selector.startAfter);
    filters.unshift(`id > $${params.length}`);
  } else if (selector.checkpointMode) {
    filters.push('last_enriched_at is not null');
  } else {
    params.push(selector.startAfter);
    filters.unshift(`id > $${params.length}`);
  }

  if (selector.changedSinceHours !== null) {
    params.push(String(selector.changedSinceHours));
    filters.push(`last_enriched_at >= now() - ($${params.length}::text || ' hours')::interval`);
  }

  if (selector.checkpointAfter && !selector.reconcile) {
    params.push(selector.checkpointAfter.lastEnrichedAt);
    const tsParam = params.length;
    params.push(selector.checkpointAfter.id);
    const idParam = params.length;
    filters.push(`(last_enriched_at, id) > ($${tsParam}::timestamptz, $${idParam}::int)`);
  }

  if (selector.onlyClassified) {
    filters.push('(style is not null or price is not null or price_range is not null or style_confidence is not null)');
  }

  params.push(selector.batch);
  const limitParam = params.length;
  const orderBy = selector.checkpointMode && !selector.reconcile ? 'last_enriched_at asc, id asc' : 'id asc';

  const sql = `
        select
          ${syncColumnsForEntity(LOCAL_SYNC_COLS, entity).join(',\n          ')},
          ${LOCAL_SYNC_CHECKPOINT_COL}
        from ${targetTable}
        where ${filters.join('\n          and ')}
        order by ${orderBy}
        limit $${limitParam}
      `;
  return { sql, params };
}

export function localSyncSelectQuery(options = {}) {
  return localSyncSelect(options).sql;
}

export function localSyncSelectSql(options = {}) {
  return localSyncSelectQuery(options);
}

export function localSyncSelectParams(options = {}) {
  return localSyncSelect(options).params;
}

export function localSyncSelectQueryParams(options = {}) {
  return localSyncSelect(options).params;
}

export function buildSupabasePayload(local, current, {
  nowIso = new Date().toISOString(),
  lifecycleOnly = false,
  entity = 'pizza',
} = {}) {
  if (!current) return null;
  // Numeric IDs alone are not a cross-database identity: locally imported
  // restaurants can collide with places entered directly on the public site.
  assertSupabasePlaceIdentity(local, current, { entity });

  const payload = { id: local.id };

  for (const col of lifecycleOnly ? [] : syncColumnsForEntity(OVERWRITE_COLS, entity)) {
    const value = local[col];
    if (value !== null && value !== undefined && !syncValuesEqual(value, current[col])) {
      payload[col] = value;
    }
  }

  // A non-null local canonical value is authoritative for the public mirror.
  // Null local values never clear a public value.
  for (const col of lifecycleOnly ? [] : syncColumnsForEntity(CANONICAL_MIRROR_COLS, entity)) {
    const localValue = local[col];
    if (localValue !== null && localValue !== undefined && !syncValuesEqual(localValue, current[col])) {
      payload[col] = localValue;
    }
  }

  // Unlike enrichment fields, lifecycle decisions may be intentionally
  // cleared back to active, so compare and sync nulls as well as values.
  for (const col of LIFECYCLE_COLS) {
    if (!syncValuesEqual(local[col], current[col])) payload[col] = local[col] ?? null;
  }

  if (!lifecycleOnly) {
    const qaColumns = new Set(syncColumnsForEntity(QA_DEFAULT_COLS, entity));
    if (qaColumns.has('qa_status') && current.qa_status == null) payload.qa_status = 'unreviewed';
    if (qaColumns.has('qa_schema_version') && current.qa_schema_version == null) payload.qa_schema_version = 1;
  }

  if (Object.keys(payload).length <= 1) return null;
  if (!('updated_at' in payload)) payload.updated_at = nowIso;
  return payload;
}

function normalizeSyncValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
      const date = new Date(trimmed);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
    return trimmed;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.stringify(value);
}

function syncValuesEqual(localValue, supabaseValue) {
  return normalizeSyncValue(localValue) === normalizeSyncValue(supabaseValue);
}

export function buildSupabaseInsertPayload(local, { nowIso = new Date().toISOString(), entity = 'pizza' } = {}) {
  const payload = {};

  for (const col of LOCAL_CONTEXT_COLS) {
    const value = local[col];
    if (value !== null && value !== undefined) {
      payload[col] = col === 'state' ? normalizeSupabaseState(value) : value;
    }
  }

  for (const col of [
    ...syncColumnsForEntity(OVERWRITE_COLS, entity),
    ...syncColumnsForEntity(CANONICAL_MIRROR_COLS, entity),
    ...LIFECYCLE_COLS,
  ]) {
    const value = local[col];
    if (value !== null && value !== undefined) payload[col] = value;
  }

  const qaColumns = new Set(syncColumnsForEntity(QA_DEFAULT_COLS, entity));
  if (qaColumns.has('qa_status') && payload.qa_status == null) payload.qa_status = 'unreviewed';
  if (qaColumns.has('qa_schema_version') && payload.qa_schema_version == null) payload.qa_schema_version = 1;
  if (!('updated_at' in payload)) payload.updated_at = nowIso;
  if (syncColumnsForEntity(['created_at'], entity).length && !('created_at' in payload)) payload.created_at = nowIso;

  return payload;
}

export function canonicalMirrorMismatches(local, current) {
  if (!current) return [];

  return CANONICAL_MIRROR_COLS
    .filter(col => local[col] !== null && local[col] !== undefined && current[col] !== null && current[col] !== undefined)
    .map(col => ({
      column: col,
      local: local[col],
      supabase: current[col],
      differs: local[col] !== current[col],
    }));
}
