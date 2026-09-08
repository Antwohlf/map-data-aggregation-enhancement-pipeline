#!/usr/bin/env node
/**
 * Sync local Postgres enrichment data -> Supabase pizza_places.
 *
 * Mode: Option 2
 * - Overwrite raw enrichment blobs/fields in Supabase when local has a non-null value.
 * - Mirror non-null canonical classification fields; null local values never clear public values.
 * - Never touches core identity fields (name/lat/lng/address/state/google_place_id/status/notes/rating).
 *
 * Requires .env.local:
 * - VITE_SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY
 * Optional local DB overrides:
 * - LOCAL_DB_HOST, LOCAL_DB_PORT, LOCAL_DB_NAME, LOCAL_DB_USER, LOCAL_DB_PASSWORD
 */

import pg from 'pg';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { createClient } from '@supabase/supabase-js';
import {
  checkpointFromRow,
  idCheckpointFromRow,
  readIdCheckpoint,
  readSyncCheckpoint,
  writeSyncCheckpoint,
} from './lib/supabase-sync-checkpoint.mjs';
import {
  buildSupabasePayload,
  assertSupabaseSyncTableBoundary,
  localSyncSelectParams,
  localSyncSelectSql,
  SUPABASE_SYNC_SELECT_COLS,
  supabaseSyncSelectCols,
  buildSupabaseInsertPayload,
} from './lib/supabase-sync-policy.mjs';
import { supabaseSyncProfile } from './lib/supabase-sync-profiles.mjs';
import { resolveSupabaseSyncCredentials } from './lib/supabase-sync-credentials.mjs';

const MAX_SYNC_BATCH_SIZE = 500;

function parseArgs(argv) {
  const out = {
    ids: [],
    entity: process.env.APIZZA_SYNC_ENTITY || 'pizza',
    batch: 500,
    startAfter: 0,
    maxBatches: 0, // 0 = unlimited
    dryRun: false,
    verbose: false,
    changedSinceHours: null,
    onlyClassified: false,
    insertMissingReviewedNew: false,
    checkpointPath: null,
    reconcile: false,
    concurrency: parseInt(process.env.APIZZA_SYNC_CONCURRENCY || '1', 10),
    bulkRpc: false,
    lifecycleOnly: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--only-classified') out.onlyClassified = true;
    else if (a === '--insert-missing-reviewed-new') out.insertMissingReviewedNew = true;
    else if (a === '--entity') out.entity = String(argv[++i] || '').trim().toLowerCase();
    else if (a === '--ids') out.ids = parseIds(argv[++i]);
    else if (a === '--batch') out.batch = parseInt(argv[++i], 10);
    else if (a === '--start-after') out.startAfter = parseInt(argv[++i], 10);
    else if (a === '--max-batches') out.maxBatches = parseInt(argv[++i], 10);
    else if (a === '--changed-since-hours') out.changedSinceHours = parseFloat(argv[++i]);
    else if (a === '--checkpoint') out.checkpointPath = argv[++i];
    else if (a === '--reconcile') out.reconcile = true;
    else if (a === '--concurrency') out.concurrency = parseInt(argv[++i], 10);
    else if (a === '--bulk-rpc') out.bulkRpc = true;
    else if (a === '--lifecycle-only') out.lifecycleOnly = true;
    else if (a === '--help') {
      console.log(`Usage: node scripts/sync-local-to-supabase.mjs [options]

Options:
  --entity <pizza|taco>       Sync entity (default pizza; taco is dry-run only)
  --batch <n>                 Batch size (default 500)
  --ids <a,b,c>               Sync only these local pizza_places ids
  --start-after <id>          Start after this numeric id (default 0)
  --max-batches <n>           Stop after n batches (default 0 = unlimited)
  --changed-since-hours <n>   Only scan rows enriched in the last n hours
  --only-classified           Only scan rows with style/price classification output
  --insert-missing-reviewed-new
                              With --ids, insert missing Supabase rows only when
                              local place_sources proves reviewed_new_import
  --checkpoint <path>         Resume/save a last_enriched_at + id checkpoint
  --reconcile                 Scan all eligible local rows after an ID checkpoint
  --concurrency <n>           Run independent Supabase writes concurrently (env APIZZA_SYNC_CONCURRENCY)
  --bulk-rpc                  Apply updates through the guarded database-side batch RPC
  --lifecycle-only            Publish only lifecycle fields for explicit IDs
  --dry-run                   Print what would happen, do not write to Supabase
  --verbose                   Extra logging
`);
      process.exit(0);
    }
  }
  if (!Number.isFinite(out.batch) || out.batch <= 0 || out.batch > MAX_SYNC_BATCH_SIZE) {
    throw new Error(`Invalid --batch; use 1-${MAX_SYNC_BATCH_SIZE}`);
  }
  supabaseSyncProfile(out.entity);
  if (out.ids.length && out.checkpointPath) throw new Error('--ids cannot be combined with --checkpoint');
  if (out.reconcile && out.ids.length) throw new Error('--reconcile cannot be combined with --ids');
  if (out.reconcile && (out.changedSinceHours !== null || out.onlyClassified)) {
    throw new Error('--reconcile cannot be combined with --changed-since-hours or --only-classified');
  }
  if (!Number.isFinite(out.startAfter) || out.startAfter < 0) throw new Error('Invalid --start-after');
  if (!Number.isFinite(out.maxBatches) || out.maxBatches < 0) throw new Error('Invalid --max-batches');
  if (!Number.isInteger(out.concurrency) || out.concurrency <= 0) throw new Error('Invalid --concurrency');
  if (out.changedSinceHours !== null && (!Number.isFinite(out.changedSinceHours) || out.changedSinceHours <= 0)) {
    throw new Error('Invalid --changed-since-hours');
  }
  if (out.lifecycleOnly) {
    if (!out.ids.length) throw new Error('--lifecycle-only requires explicit --ids');
    if (out.checkpointPath || out.reconcile || out.changedSinceHours !== null || out.onlyClassified || out.insertMissingReviewedNew) {
      throw new Error('--lifecycle-only only supports explicit IDs, batching, dry-run, and bulk RPC');
    }
    if (!/^(1|true|yes)$/i.test(String(process.env.ENABLE_LIFECYCLE_SYNC || '').trim())) {
      throw new Error('--lifecycle-only requires ENABLE_LIFECYCLE_SYNC=1');
    }
  }
  return out;
}

function parseIds(value) {
  const ids = String(value || '')
    .split(',')
    .map(item => Number(item.trim()))
    .filter(id => Number.isInteger(id) && id > 0);
  if (!ids.length) throw new Error('Invalid --ids');
  return [...new Set(ids)];
}

function loadEnvLocal() {
  const p = resolve(process.cwd(), '.env.local');
  if (!existsSync(p)) return {};
  const txt = readFileSync(p, 'utf8');
  const out = {};
  for (const line of txt.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    out[k] = v;
  }
  return out;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isRetryableSupabaseError(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  if (status >= 400 && status < 500) return false;
  const message = String(error?.message || error || '').toLowerCase();
  return !status || status >= 500 || /fetch failed|network|timeout|timed out|econnreset|enotfound|eai_again/.test(message);
}

async function supabaseRequest(operation, label, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await operation();
      if (result?.error) throw result.error;
      return result;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableSupabaseError(error)) throw error;
      const delayMs = 1000 * (2 ** (attempt - 1));
      console.warn(`[supabase retry] ${label}; attempt=${attempt + 1}/${attempts} delay_ms=${delayMs}`);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

async function runConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function consume() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, consume));
  return results;
}

async function insertSupabaseRow(sb, targetTable, payload) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const { data } = await supabaseRequest(
        () => sb.from(targetTable).insert(payload).select('id'),
        `insert id=${payload.id}`,
        1,
      );
      return data;
    } catch (error) {
      if (attempt >= 4 || !isRetryableSupabaseError(error)) throw error;
      // A network failure can happen after Supabase commits the insert. Check
      // by primary key before retrying so recovery cannot create a duplicate.
      const existing = await supabaseRequest(
        () => sb.from(targetTable).select('id').eq('id', payload.id),
        `confirm insert id=${payload.id}`,
      );
      if (existing.data?.length) return existing.data;
      const delayMs = 1000 * (2 ** (attempt - 1));
      console.warn(`[supabase retry] insert id=${payload.id}; attempt=${attempt + 1}/4 delay_ms=${delayMs}`);
      await sleep(delayMs);
    }
  }
  throw new Error(`Supabase insert failed for id=${payload.id}`);
}

async function applyBulkSupabaseUpdates(sb, bulkRpc, updates) {
  const result = await supabaseRequest(
    () => sb.rpc(bulkRpc, { p_rows: updates }),
    `bulk update rows=${updates.length}`,
  );
  const updatedCount = Number(result?.data?.updated_count);
  if (!Number.isInteger(updatedCount) || updatedCount !== updates.length) {
    throw new Error(`Bulk sync updated ${Number.isFinite(updatedCount) ? updatedCount : 'an unknown number of'} rows; expected ${updates.length}`);
  }
  return updatedCount;
}

async function main() {
  const args = parseArgs(process.argv);
  const profile = supabaseSyncProfile(args.entity);
  if (!args.dryRun && !profile.publicationEnabled) {
    throw new Error(`${args.entity} publication is disabled; use --dry-run until its public schema and guarded RPC are enabled.`);
  }
  const env = loadEnvLocal();
  const bulkRpc = args.bulkRpc || /^(1|true|yes)$/i.test(String(env.APIZZA_SYNC_BULK_RPC || process.env.APIZZA_SYNC_BULK_RPC || '').trim());
  assertSupabaseSyncTableBoundary({ entity: args.entity, targetTable: profile.targetTable });

  const credentials = resolveSupabaseSyncCredentials({ ...process.env, ...env }, { dryRun: args.dryRun });
  const supabaseUrl = credentials.url;
  const supabaseKey = credentials.key;

  const dbConfig = {
    host: env.LOCAL_DB_HOST || 'localhost',
    port: parseInt(env.LOCAL_DB_PORT || '5432', 10),
    database: env.LOCAL_DB_NAME || 'pizza_enrichment',
    user: env.LOCAL_DB_USER || process.env.USER,
    password: env.LOCAL_DB_PASSWORD || '',
  };

  const sb = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
  const client = new pg.Client(dbConfig);
  await client.connect();

  if (bulkRpc) console.log(`[sync] bulk RPC enabled: ${profile.bulkRpc}`);

  let cursor = args.startAfter;
  let checkpointAfter = args.reconcile
    ? readIdCheckpoint(args.checkpointPath)
    : readSyncCheckpoint(args.checkpointPath);
  let batchNum = 0;
  let totalUpdates = 0;
  let totalInserts = 0;
  let totalRowsScanned = 0;

  try {
    while (true) {
      if (args.maxBatches && batchNum >= args.maxBatches) break;

      // Pull a chunk of local rows that have anything worth syncing.
      // (We still include rows where only style/price are present so we can NULL-fill.)
      const selector = {
        ...args,
        targetTable: profile.targetTable,
        startAfter: cursor,
        checkpointMode: Boolean(args.checkpointPath) && !args.reconcile,
        reconcile: args.reconcile,
        checkpointAfter,
      };
      const { rows: localRows } = await client.query(localSyncSelectSql(selector), localSyncSelectParams(selector));
      if (!localRows.length) break;

      batchNum++;
      totalRowsScanned += localRows.length;
      cursor = localRows[localRows.length - 1].id;

      const ids = localRows.map(r => r.id);

      // Fetch current supabase state for protected fields + QA.
      const { data: sbRows } = await supabaseRequest(
        () => sb
          .from(profile.targetTable)
          .select(supabaseSyncSelectCols(args.entity).join(', '))
          .in('id', ids),
        `read ids=${ids.length}`,
      );

      // Supabase may return ids as strings; normalize keys to string for reliable lookup.
      const sbMap = new Map((sbRows || []).map(r => [String(r.id), r]));
      let reviewedNewImportedIds = new Set();
      if (args.insertMissingReviewedNew) {
        const { rows: reviewedRows } = await client.query(`
          SELECT DISTINCT place_id::int AS place_id
          FROM place_sources
          WHERE entity_type = $2
            AND match_method = 'reviewed_new_import'
            AND place_id = ANY($1::int[])
          UNION
          SELECT DISTINCT canonical_place_id::int AS place_id
          FROM source_review_queue
          WHERE entity_type = $2
            AND status IN ('accepted', 'linked')
            AND decision = 'imported_new'
            AND canonical_place_id = ANY($1::int[])
        `, [ids, args.entity]);
        reviewedNewImportedIds = new Set(reviewedRows.map(row => Number(row.place_id)));
      }

      const updates = [];
      const inserts = [];
      let wouldUpdate = 0;
      let wouldInsert = 0;

      for (const local of localRows) {
        const current = sbMap.get(String(local.id));
        if (!current) {
          if (args.insertMissingReviewedNew && reviewedNewImportedIds.has(Number(local.id))) {
            inserts.push(buildSupabaseInsertPayload(local, { entity: args.entity }));
            wouldInsert++;
          } else if (args.verbose) {
            // No row in Supabase with this id. We skip to avoid duplicates.
            console.warn('[skip missing supabase row]', local.id);
          }
          continue;
        }

      const payload = buildSupabasePayload(local, current, { lifecycleOnly: args.lifecycleOnly, entity: args.entity });
        if (payload) {
          updates.push(payload);
          wouldUpdate++;
        }
      }

      if (args.dryRun) {
        const selectorText = [
          `ids=${selector.ids?.length ? selector.ids.join(',') : 'none'}`,
          `start_after=${selector.startAfter}`,
          `changed_since_hours=${selector.changedSinceHours ?? 'none'}`,
          `only_classified=${selector.onlyClassified}`,
          `lifecycle_only=${selector.lifecycleOnly}`,
          `checkpoint=${args.checkpointPath || 'none'}`,
          `checkpoint_after=${checkpointAfter ? `${checkpointAfter.lastEnrichedAt}/${checkpointAfter.id}` : 'none'}`,
        ].join(' ');
        console.log(`[dry-run] batch ${batchNum}: local_rows=${localRows.length} supabase_rows=${(sbRows||[]).length} would_update=${wouldUpdate} would_insert=${wouldInsert} cursor=${cursor} ${selectorText}`);
        if (args.verbose && updates.length) {
          console.log('sample update payload:', JSON.stringify(updates[0], null, 2));
        }
        if (args.verbose && inserts.length) {
          console.log('sample insert payload:', JSON.stringify(inserts[0], null, 2));
        }
        const nextCheckpoint = args.reconcile
          ? idCheckpointFromRow(localRows[localRows.length - 1])
          : checkpointFromRow(localRows[localRows.length - 1]);
        if (args.checkpointPath && nextCheckpoint) {
          checkpointAfter = args.reconcile
            ? { lastId: nextCheckpoint.last_id, source: args.checkpointPath }
            : {
              lastEnrichedAt: nextCheckpoint.last_enriched_at,
              id: nextCheckpoint.id,
              source: args.checkpointPath,
            };
        }
        if (args.ids.length) break;
        continue;
      }

      if (!updates.length && !inserts.length) {
        const nextCheckpoint = args.reconcile
          ? idCheckpointFromRow(localRows[localRows.length - 1])
          : checkpointFromRow(localRows[localRows.length - 1]);
        if (args.checkpointPath && nextCheckpoint) {
          writeSyncCheckpoint(args.checkpointPath, nextCheckpoint);
          checkpointAfter = args.reconcile
            ? { lastId: nextCheckpoint.last_id, source: args.checkpointPath }
            : {
              lastEnrichedAt: nextCheckpoint.last_enriched_at,
              id: nextCheckpoint.id,
              source: args.checkpointPath,
            };
        }
        console.log(`[ok] batch ${batchNum}: nothing to update or insert (local_rows=${localRows.length}, cursor=${cursor})`);
        if (args.ids.length) break;
        continue;
      }

      const insertResults = await runConcurrent(inserts, args.concurrency, async payload => {
        const data = await insertSupabaseRow(sb, profile.targetTable, payload);
        if (!data?.length) {
          throw new Error(`Supabase insert returned no row for id=${payload.id}`);
        }
        return data;
      });

      const updateResults = bulkRpc && updates.length
        ? [await applyBulkSupabaseUpdates(sb, profile.bulkRpc, updates)]
        : await runConcurrent(updates, args.concurrency, async payload => {
          const { id, ...fields } = payload;
          const { data } = await supabaseRequest(
            () => sb
              .from(profile.targetTable)
              .update(fields)
              .eq('id', id)
              .select('id'),
            `update id=${id}`,
          );
          if (!data?.length) {
            throw new Error(`Supabase update matched no rows for id=${id}`);
          }
          return data;
        });

      const inserted = insertResults.length;
      const updated = bulkRpc && updates.length ? updateResults[0] : updateResults.length;

      totalUpdates += updated;
      totalInserts += inserted;
      const nextCheckpoint = args.reconcile
        ? idCheckpointFromRow(localRows[localRows.length - 1])
        : checkpointFromRow(localRows[localRows.length - 1]);
      if (args.checkpointPath && nextCheckpoint) {
        writeSyncCheckpoint(args.checkpointPath, nextCheckpoint);
        checkpointAfter = args.reconcile
          ? { lastId: nextCheckpoint.last_id, source: args.checkpointPath }
          : {
            lastEnrichedAt: nextCheckpoint.last_enriched_at,
            id: nextCheckpoint.id,
            source: args.checkpointPath,
          };
      }
      console.log(`[ok] batch ${batchNum}: updated=${updated} inserted=${inserted} local_rows=${localRows.length} cursor=${cursor}`);
      if (args.ids.length) break;
    }

    console.log(`Done. batches=${batchNum} local_rows_scanned=${totalRowsScanned} supabase_rows_updated=${totalUpdates} supabase_rows_inserted=${totalInserts} last_cursor=${cursor}`);
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('sync-local-to-supabase failed:', err);
  process.exit(1);
});
