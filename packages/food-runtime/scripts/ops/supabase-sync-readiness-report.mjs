#!/usr/bin/env node
/**
 * Read-only report for local Postgres -> Supabase sync readiness.
 *
 * Shows the exact fields that would be updated by sync-local-to-supabase.mjs
 * for the selected batch without writing to Supabase.
 */

import pg from 'pg';
import { resolve } from 'path';
import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'child_process';
import { readIdCheckpoint, readSyncCheckpoint } from '../lib/supabase-sync-checkpoint.mjs';
import { loadRuntimeEnvironment } from '../lib/runtime-environment.mjs';
import {
  CANONICAL_MIRROR_COLS,
  LIFECYCLE_COLS,
  LIFECYCLE_SYNC_ENABLED,
  LOCAL_ONLY_SUPABASE_TABLES,
  OVERWRITE_COLS,
  QA_DEFAULT_COLS,
  supabaseSyncSelectCols,
  assertSupabaseSyncTableBoundary,
  buildSupabasePayload,
  localSyncSelectParams,
  localSyncSelectSql,
} from '../lib/supabase-sync-policy.mjs';
import { supabaseSyncProfile } from '../lib/supabase-sync-profiles.mjs';

function parseArgs(argv) {
  const out = {
    ids: [],
    batch: 100,
    startAfter: 0,
    sample: 10,
    changedSinceHours: null,
    onlyClassified: false,
    checkpointPath: null,
    reconcile: false,
    json: false,
    lifecycleOnly: false,
    entity: process.env.APIZZA_SYNC_ENTITY || 'pizza',
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--batch') out.batch = parseInt(argv[++i], 10);
    else if (arg === '--ids') out.ids = parseIds(argv[++i]);
    else if (arg === '--start-after') out.startAfter = parseInt(argv[++i], 10);
    else if (arg === '--sample') out.sample = parseInt(argv[++i], 10);
    else if (arg === '--changed-since-hours') out.changedSinceHours = parseFloat(argv[++i]);
    else if (arg === '--only-classified') out.onlyClassified = true;
    else if (arg === '--checkpoint') out.checkpointPath = argv[++i];
    else if (arg === '--reconcile') out.reconcile = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--lifecycle-only') out.lifecycleOnly = true;
    else if (arg === '--entity') out.entity = String(argv[++i] || '').trim().toLowerCase();
    else if (arg === '--help') {
      console.log(`Usage: node scripts/ops/supabase-sync-readiness-report.mjs [options]

Options:
  --batch <n>                 Number of local rows to inspect (default 100)
  --ids <a,b,c>               Inspect only these local pizza_places ids
  --start-after <id>          Start after this numeric id (default 0)
  --changed-since-hours <n>   Only inspect rows enriched in the last n hours
  --only-classified           Only inspect rows with style/price classification output
  --checkpoint <path>         Resume from a last_enriched_at + id checkpoint
  --reconcile                 Use an ID-based checkpoint and scan all eligible rows
  --lifecycle-only            Inspect only lifecycle fields for explicit IDs
  --sample <n>                Rows per detail table (default 10)
  --entity <name>             Sync profile to inspect (pizza or taco)
  --json                      Emit JSON instead of Markdown
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(out.batch) || out.batch <= 0) throw new Error('Invalid --batch');
  if (out.ids.length && out.checkpointPath) throw new Error('--ids cannot be combined with --checkpoint');
  if (out.reconcile && out.ids.length) throw new Error('--reconcile cannot be combined with --ids');
  if (out.reconcile && (out.changedSinceHours !== null || out.onlyClassified)) {
    throw new Error('--reconcile cannot be combined with --changed-since-hours or --only-classified');
  }
  if (!Number.isFinite(out.startAfter) || out.startAfter < 0) throw new Error('Invalid --start-after');
  if (!Number.isFinite(out.sample) || out.sample <= 0) throw new Error('Invalid --sample');
  if (out.changedSinceHours !== null && (!Number.isFinite(out.changedSinceHours) || out.changedSinceHours <= 0)) {
    throw new Error('Invalid --changed-since-hours');
  }
  if (out.lifecycleOnly) {
    if (!out.ids.length) throw new Error('--lifecycle-only requires explicit --ids');
    if (out.checkpointPath || out.reconcile || out.changedSinceHours !== null || out.onlyClassified) {
      throw new Error('--lifecycle-only only supports explicit IDs and inspection options');
    }
    if (!LIFECYCLE_SYNC_ENABLED) throw new Error('--lifecycle-only requires ENABLE_LIFECYCLE_SYNC=1');
  }
  supabaseSyncProfile(out.entity);
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

function run(cmd, args = [], options = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeout || 10000,
      ...options,
    }).trim();
  } catch {
    return '';
  }
}

function repoRoot() {
  return run('git', ['rev-parse', '--show-toplevel']) || process.cwd();
}

function gitReport(root) {
  return {
    branch: run('git', ['branch', '--show-current'], { cwd: root }) || '(unknown)',
    head: run('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }) || '(unknown)',
    status: run('git', ['status', '--short', '--branch'], { cwd: root }) || '(status unavailable)',
  };
}

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)));
}

function compactPayload(payload) {
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined) out[key] = value;
    else if (typeof value === 'object') out[key] = '[object]';
    else {
      const text = String(value);
      out[key] = text.length > 120 ? `${text.slice(0, 120)}...` : value;
    }
  }
  return out;
}

function table(headers, rows) {
  if (!rows.length) return '_none_';
  const escape = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map(row => `| ${headers.map(header => escape(row[header])).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

function sample(rows, options) {
  return rows.slice(0, options.sample);
}

async function main() {
  const options = parseArgs(process.argv);
  const root = repoRoot();
  const env = loadRuntimeEnvironment();
  const profile = supabaseSyncProfile(options.entity);
  const syncBoundary = assertSupabaseSyncTableBoundary({ entity: options.entity, targetTable: profile.targetTable });

  const supabaseUrl = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing VITE_SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  }

  const client = new pg.Client({
    host: env.LOCAL_DB_HOST || 'localhost',
    port: parseInt(env.LOCAL_DB_PORT || '5432', 10),
    database: env.LOCAL_DB_NAME || 'pizza_enrichment',
    user: env.LOCAL_DB_USER || process.env.USER,
    password: env.LOCAL_DB_PASSWORD || '',
  });

  await client.connect();

  try {
    const checkpointAfter = options.reconcile
      ? readIdCheckpoint(options.checkpointPath)
      : readSyncCheckpoint(options.checkpointPath);
    const selector = {
      ...options,
      targetTable: profile.targetTable,
      checkpointMode: Boolean(options.checkpointPath) && !options.reconcile,
      checkpointAfter,
    };
    const { rows: localRows } = await client.query(localSyncSelectSql(selector), localSyncSelectParams(selector));
    const ids = localRows.map(row => row.id);
    const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
    const lifecycleSchemaCheck = await supabase
      .from(profile.targetTable)
      .select('id, lifecycle_status, lifecycle_replaced_by_id')
      .limit(1);
    const lifecycleRemoteSchema = lifecycleSchemaCheck.error
      ? {
        state: /column .* does not exist/i.test(lifecycleSchemaCheck.error.message || '') ? 'missing' : 'unavailable',
        detail: lifecycleSchemaCheck.error.message,
      }
      : { state: 'ready', detail: 'Supabase exposes both lifecycle columns.' };

    const { data: sbRows, error } = await supabase
      .from(profile.targetTable)
      .select(supabaseSyncSelectCols(options.entity).join(', '))
      .in('id', ids);

    if (error) throw error;

    const sbMap = new Map((sbRows || []).map(row => [String(row.id), row]));
    const nowIso = new Date().toISOString();
    const updates = [];
    const missingSupabaseRows = [];

    for (const local of localRows) {
      const current = sbMap.get(String(local.id));
      if (!current) {
        missingSupabaseRows.push(local);
        continue;
      }

      const payload = buildSupabasePayload(local, current, { nowIso, lifecycleOnly: options.lifecycleOnly, entity: options.entity });
      if (payload) updates.push({ local, current, payload });
    }

    const changedFields = updates.flatMap(item => Object.keys(item.payload).filter(key => key !== 'id'));
    const canonicalMirrorWrites = changedFields.filter(col => CANONICAL_MIRROR_COLS.includes(col));
    const overwriteWrites = changedFields.filter(col => OVERWRITE_COLS.includes(col));
    const qaDefaults = changedFields.filter(col => QA_DEFAULT_COLS.includes(col));

    const state = !LIFECYCLE_SYNC_ENABLED && options.lifecycleOnly
      ? 'BLOCKED'
      : missingSupabaseRows.length
        ? 'WARN'
        : (LIFECYCLE_SYNC_ENABLED && lifecycleRemoteSchema.state !== 'ready' ? 'BLOCKED' : 'OK');
    const lifecyclePublication = LIFECYCLE_SYNC_ENABLED
      ? lifecycleRemoteSchema.state === 'ready'
        ? {
          state: 'ready',
          action: 'No lifecycle configuration change is required; the guarded sync may publish lifecycle fields.',
        }
        : {
          state: 'blocked',
          action: 'Apply the additive Supabase lifecycle migration, then rerun this report before syncing.',
        }
      : {
        state: 'disabled_for_this_process',
        action: 'Run this report with ENABLE_LIFECYCLE_SYNC=1 when validating the launchd publication environment.',
      };
    const payloadSamples = sample(updates, options).map(item => ({
      id: item['local'].id,
      name: item['local'].name,
      state: item['local'].state,
      google_place_id: item['local'].google_place_id,
      fields: Object.keys(item.payload).filter(key => key !== 'id').join(', '),
      payload: JSON.stringify(compactPayload(item.payload)),
    }));

    const result = {
      generatedAt: new Date().toISOString(),
      state,
      repo: { root, ...gitReport(root) },
      syncBoundary: {
        ...syncBoundary,
        status: 'OK',
        note: `Only canonical ${profile.targetTable} rows are eligible for this sync profile; provenance/review tables remain local-only.`,
      },
      lifecycleSync: {
        enabled: LIFECYCLE_SYNC_ENABLED,
        columns: [...LIFECYCLE_COLS],
        remoteSchema: lifecycleRemoteSchema,
        publication: lifecyclePublication,
        note: LIFECYCLE_SYNC_ENABLED
          ? 'Lifecycle columns are included in the sync contract; the Supabase migration must already be applied.'
          : 'Lifecycle fields remain local-only until the Supabase migration is applied and ENABLE_LIFECYCLE_SYNC=1 is set.',
      },
      options: {
        ...options,
        entity: profile.entity,
        profile,
        checkpointAfter,
      },
      totals: {
        localRows: localRows.length,
        supabaseRows: sbRows?.length || 0,
        wouldUpdate: updates.length,
        missingSupabaseRows: missingSupabaseRows.length,
        canonicalMirrorWrites: canonicalMirrorWrites.length,
        overwriteWrites: overwriteWrites.length,
        qaDefaults: qaDefaults.length,
      },
      fieldCounts: countBy(changedFields, value => value),
      // Protected-field accounting is not part of the current sync profile.
      // Keep the report sections stable and explicit rather than crashing while
      // rendering fields from the retired accounting path.
      protectedFillCounts: [],
      protectedSkipCounts: [],
      protectedConflictSamples: [],
      payloadSamples,
      missingSupabaseSamples: sample(missingSupabaseRows, options).map(row => ({
        id: row.id,
        name: row.name,
        state: row.state,
        google_place_id: row.google_place_id,
      })),
    };

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`# Supabase Sync Readiness: ${result.state}`);
    console.log('');
    console.log(`Generated: ${result.generatedAt}`);
    console.log(`Repo: \`${root}\``);
    console.log(`Batch: ids=${options.ids.length ? options.ids.join(',') : 'none'}, start_after=${options.startAfter}, batch=${options.batch}, changed_since_hours=${options.changedSinceHours ?? 'none'}, only_classified=${options.onlyClassified}, lifecycle_only=${options.lifecycleOnly}, reconcile=${options.reconcile}, checkpoint=${options.checkpointPath || 'none'}`);
    if (checkpointAfter) {
      console.log(options.reconcile
        ? `Reconciliation checkpoint after: id=${checkpointAfter.lastId}`
        : `Checkpoint after: ${checkpointAfter.lastEnrichedAt} / id=${checkpointAfter.id}`);
    }
    console.log('');
    console.log('## Summary');
    console.log(`- branch/head: \`${result.repo.branch}\` / \`${result.repo.head}\``);
    console.log(`- local rows inspected: ${result.totals.localRows}`);
    console.log(`- matching Supabase rows: ${result.totals.supabaseRows}`);
    console.log(`- rows that would update: ${result.totals.wouldUpdate}`);
    console.log(`- missing Supabase rows: ${result.totals.missingSupabaseRows}`);
    console.log(`- canonical classification mirror writes: ${result.totals.canonicalMirrorWrites}`);
    console.log(`- overwrite-field writes: ${result.totals.overwriteWrites}`);
    console.log(`- QA default writes: ${result.totals.qaDefaults}`);
    console.log('');

    console.log('## Sync Boundary');
    console.log(`- target table: \`${result.syncBoundary.targetTable}\``);
    console.log(`- local-only tables: ${LOCAL_ONLY_SUPABASE_TABLES.map(tableName => `\`${tableName}\``).join(', ')}`);
    console.log(`- status: ${result.syncBoundary.status}`);
    console.log(`- note: ${result.syncBoundary.note}`);
    console.log('');

    console.log('## Lifecycle Sync');
    console.log(`- enabled: ${result.lifecycleSync.enabled ? 'yes' : 'no'}`);
    console.log(`- columns: ${result.lifecycleSync.columns.length ? result.lifecycleSync.columns.map(column => `\`${column}\``).join(', ') : 'none'}`);
    console.log(`- remote schema: ${result.lifecycleSync.remoteSchema.state}`);
    console.log(`- publication: ${result.lifecycleSync.publication.state}`);
    console.log(`- action: ${result.lifecycleSync.publication.action}`);
    console.log(`- remote schema detail: ${result.lifecycleSync.remoteSchema.detail}`);
    console.log(`- note: ${result.lifecycleSync.note}`);
    console.log('');

    console.log('## Field Counts');
    console.log(table(['value', 'count'], result.fieldCounts));
    console.log('');

    console.log('## Protected Field Fills');
    console.log(table(['value', 'count'], result.protectedFillCounts));
    console.log('');

    console.log('## Protected Field Skips');
    console.log(table(['value', 'count'], result.protectedSkipCounts));
    console.log('');

    console.log('## Protected Conflict Samples');
    console.log(table(['id', 'name', 'state', 'google_place_id', 'column', 'local', 'supabase', 'differs'], result.protectedConflictSamples));
    console.log('');

    console.log('## Missing Supabase Row Samples');
    console.log(table(['id', 'name', 'state', 'google_place_id'], result.missingSupabaseSamples));
    console.log('');

    console.log('## Payload Samples');
    console.log(table(['id', 'name', 'state', 'google_place_id', 'fields', 'payload'], result.payloadSamples));
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch(error => {
  console.error('supabase-sync-readiness-report failed:', error);
  process.exit(1);
});
