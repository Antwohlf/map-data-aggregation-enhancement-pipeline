#!/usr/bin/env node
/**
 * Read-only status report for checkpointed local Postgres -> Supabase sync.
 */

import pg from 'pg';
import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'child_process';
import { readSyncCheckpoint } from '../lib/supabase-sync-checkpoint.mjs';
import { readSyncRunState, syncRunStatePath } from '../lib/supabase-sync-run-state.mjs';
import { summarizeSyncStatusError } from '../lib/supabase-sync-status.mjs';
import { defaultSyncStatusFile } from '../lib/supabase-sync-status-file.mjs';
import {
  supabaseSyncSelectCols,
  assertSupabaseSyncTableBoundary,
  buildSupabasePayload,
  localSyncSelectParams,
  localSyncSelectSql,
  CANONICAL_MIRROR_COLS,
} from '../lib/supabase-sync-policy.mjs';
import { supabaseSyncProfile } from '../lib/supabase-sync-profiles.mjs';

function parseArgs(argv) {
  const out = {
    hours: 6,
    batch: 50,
    sample: 10,
    checkpoint: null,
    requireBulkRpc: false,
    entity: process.env.APIZZA_SYNC_ENTITY || 'pizza',
    json: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--hours') out.hours = parseFloat(argv[++i]);
    else if (arg === '--batch') out.batch = parseInt(argv[++i], 10);
    else if (arg === '--sample') out.sample = parseInt(argv[++i], 10);
    else if (arg === '--checkpoint') out.checkpoint = argv[++i];
    else if (arg === '--require-bulk-rpc') out.requireBulkRpc = true;
    else if (arg === '--entity') out.entity = String(argv[++i] || '').trim().toLowerCase();
    else if (arg === '--json') out.json = true;
    else if (arg === '--help') {
      console.log(`Usage: node scripts/ops/supabase-sync-status-report.mjs [options]

Options:
  --hours <n>       Recent enrichment window (default 6)
  --batch <n>       Next batch size to inspect (default 50)
  --sample <n>      Rows per detail table (default 10)
  --entity <name>   Sync profile to inspect (pizza or taco)
  --checkpoint <p>  Checkpoint path (defaults per entity; pizza keeps the legacy path)
  --require-bulk-rpc Require the low-I/O bulk RPC to be available
  --json            Emit JSON instead of Markdown
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(out.hours) || out.hours <= 0) throw new Error('Invalid --hours');
  if (!Number.isFinite(out.batch) || out.batch <= 0) throw new Error('Invalid --batch');
  if (!Number.isFinite(out.sample) || out.sample <= 0) throw new Error('Invalid --sample');
  supabaseSyncProfile(out.entity);
  if (!out.checkpoint) {
    out.checkpoint = out.entity === 'pizza'
      ? 'scripts/.supabase-sync-checkpoint.json'
      : `scripts/.${out.entity}-supabase-sync-checkpoint.json`;
  }
  return out;
}

function loadEnvLocal() {
  const path = resolve(process.cwd(), '.env.local');
  const out = { ...process.env };
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx === -1) continue;
      out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return out;
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

function table(headers, rows) {
  if (!rows.length) return '_none_';
  const escape = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map(row => `| ${headers.map(header => escape(row[header])).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
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

function compact(row) {
  return {
    id: row.id,
    name: row.name,
    state: row.state,
    google_place_id: row.google_place_id,
    style: row.style,
    price_range: row.price_range,
    style_confidence: row.style_confidence,
    last_enriched_at: row.last_enriched_at,
  };
}

function statusFrom({ checkpoint, pendingAfterCheckpoint, nextBatch, missingRows, bulkRpc, requireBulkRpc }) {
  if ((requireBulkRpc || bulkRpc?.configured) && bulkRpc.state !== 'ready') return 'BLOCKED'
  if (!checkpoint) return 'WARN';
  if (missingRows.length) return 'WARN';
  if (nextBatch.length === 0 && pendingAfterCheckpoint > 0) return 'WARN';
  return 'OK';
}

function publicationReadiness({ lifecycleRemoteSchema, bulkRpc }) {
  if (lifecycleRemoteSchema?.state !== 'ready') {
    return {
      status: 'BLOCKED',
      reason: lifecycleRemoteSchema?.detail || 'Supabase lifecycle columns are unavailable.',
    };
  }
  if (bulkRpc?.state !== 'ready') {
    return {
      status: 'BLOCKED',
      reason: bulkRpc?.detail || 'The low-I/O bulk sync path is not ready.',
    };
  }
  return {
    status: 'READY',
    reason: bulkRpc.detail || 'The low-I/O bulk sync path is ready for guarded publication.',
  };
}

function bulkRpcConfigured(env) {
  if (/^(1|true|yes)$/i.test(String(
    env.APIZZA_SYNC_BULK_RPC || process.env.APIZZA_SYNC_BULK_RPC || '',
  ).trim())) return true;

  // Direct health/status invocations do not inherit launchd's environment.
  // Read only the installed plist's boolean setting so operational reports
  // reflect the actual scheduler configuration without reading secrets.
  const plistPath = resolve(homedir(), 'Library/LaunchAgents/com.apizzamichigan.supabase-sync.plist');
  if (!existsSync(plistPath)) return false;
  const plist = readFileSync(plistPath, 'utf8');
  return /<key>APIZZA_SYNC_BULK_RPC<\/key>\s*<string>(?:1|true|yes)<\/string>/i.test(plist);
}

async function inspectBulkRpc(supabase, configured, lifecycleRemoteSchema, rpc) {
  const result = {
    configured,
    rpc,
    available: 'unknown',
    state: 'unavailable',
    detail: '',
  };

  const { error } = await supabase.rpc(rpc, { p_rows: [] });
  if (!error) {
    result.available = true;
    result.state = configured ? 'ready' : 'not_configured';
    result.detail = configured
      ? 'Bulk RPC is available and enabled for the sync service.'
      : 'Bulk RPC is available, but the sync service is still using row-level updates.';
    return result;
  }

  result.available = false;
  if (error.code === 'PGRST202' || /could not find the function/i.test(error.message || '')) {
    result.state = 'migration_missing';
    result.detail = lifecycleRemoteSchema?.state === 'ready'
      ? `Supabase exposes the lifecycle columns but not ${rpc}(jsonb); apply the entity's bulk-sync migration (for pizza, scripts/enrichment/supabase-bulk-sync-rpc-migration.sql) before enabling low-I/O bulk sync.`
      : `Supabase does not expose ${rpc}(jsonb); apply the entity's production migration before enabling bulk sync.`;
  } else {
    result.state = 'unavailable';
    result.detail = error.message || 'Bulk RPC capability check failed.';
  }
  return result;
}

async function main() {
  const options = parseArgs(process.argv);
  const root = repoRoot();
  const git = gitReport(root);
  const profile = supabaseSyncProfile(options.entity);
  const env = loadEnvLocal();
  const checkpoint = readSyncCheckpoint(options.checkpoint);
  const runState = readSyncRunState(syncRunStatePath(
    env.APIZZA_SYNC_STATUS_FILE || defaultSyncStatusFile(options.entity),
    root,
  ));
  const syncBoundary = assertSupabaseSyncTableBoundary({ entity: options.entity, targetTable: profile.targetTable });

  const supabaseUrl = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing Supabase URL and/or key in .env.local');
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
    const summary = await client.query(`
      SELECT
        COUNT(*)::int as total,
        COUNT(*) FILTER (WHERE last_enriched_at >= now() - ($1::text || ' hours')::interval)::int as enriched_in_window,
        COUNT(*) FILTER (
          WHERE last_enriched_at >= now() - ($1::text || ' hours')::interval
            AND (style IS NOT NULL OR price IS NOT NULL OR price_range IS NOT NULL OR style_confidence IS NOT NULL)
        )::int as classified_in_window,
        COUNT(*) FILTER (
          WHERE last_enriched_at >= now() - ($1::text || ' hours')::interval
            AND (style IS NOT NULL OR price IS NOT NULL OR price_range IS NOT NULL OR style_confidence IS NOT NULL)
            AND (
              $2::timestamptz IS NULL
              OR (last_enriched_at, id) > ($2::timestamptz, $3::int)
            )
        )::int as pending_after_checkpoint,
        MAX(last_enriched_at) as latest_local_enriched_at
      FROM ${profile.targetTable}
    `, [
      String(options.hours),
      checkpoint?.lastEnrichedAt || null,
      checkpoint?.id || 0,
    ]);

    const nextSelector = {
      entity: options.entity,
      batch: options.batch,
      changedSinceHours: options.hours,
      onlyClassified: true,
      checkpointMode: true,
      checkpointAfter: checkpoint,
      targetTable: profile.targetTable,
    };
    const { rows: nextBatch } = await client.query(localSyncSelectSql(nextSelector), localSyncSelectParams(nextSelector));
    const ids = nextBatch.map(row => row.id);

    const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
    const lifecycleSchemaCheck = await supabase
      .from(profile.targetTable)
      .select('id, lifecycle_status, lifecycle_replaced_by_id')
      .limit(1);
    const lifecycleRemoteSchema = lifecycleSchemaCheck.error
      ? {
        state: /column .* does not exist/i.test(lifecycleSchemaCheck.error.message || '') ? 'missing' : 'unavailable',
        detail: lifecycleSchemaCheck.error.message || 'Lifecycle schema check failed.',
      }
      : { state: 'ready', detail: 'Supabase exposes both lifecycle columns.' };
    const bulkRpc = await inspectBulkRpc(supabase, bulkRpcConfigured(env), lifecycleRemoteSchema, profile.bulkRpc);
    const { data: sbRows, error } = ids.length
      ? await supabase
        .from(profile.targetTable)
      .select(supabaseSyncSelectCols(options.entity).join(', '))
        .in('id', ids)
      : { data: [], error: null };

    if (error) throw error;

    const sbMap = new Map((sbRows || []).map(row => [String(row.id), row]));
    const updates = [];
    const missingRows = [];

    for (const local of nextBatch) {
      const current = sbMap.get(String(local.id));
      if (!current) {
        missingRows.push(local);
        continue;
      }

      const payload = buildSupabasePayload(local, current, { entity: options.entity });
      if (payload) updates.push({ local, current, payload });
    }

    const changedFields = updates.flatMap(item => Object.keys(item.payload).filter(key => key !== 'id'));
    const fieldCounts = countBy(changedFields, value => value);
    const status = statusFrom({
      checkpoint,
      pendingAfterCheckpoint: summary.rows[0].pending_after_checkpoint,
      nextBatch,
      missingRows,
      bulkRpc,
      requireBulkRpc: options.requireBulkRpc,
    });
    const publication = profile.publicationEnabled
      ? publicationReadiness({ lifecycleRemoteSchema, bulkRpc })
      : { status: 'BLOCKED', reason: `Publication for ${options.entity} is intentionally disabled until its production contract is enabled.` };

    const payload = {
      generatedAt: new Date().toISOString(),
      status,
      publicationReadiness: publication,
      repo: { root, ...git },
      syncBoundary,
      options,
      entity: profile.entity,
      profile,
      lastRun: runState,
      checkpoint,
      lifecycleRemoteSchema,
      bulkRpc,
      summary: summary.rows[0],
      nextBatch: {
        localRows: nextBatch.length,
        supabaseRows: sbRows?.length || 0,
        wouldUpdate: updates.length,
        missingSupabaseRows: missingRows.length,
        canonicalMirrorWrites: changedFields.filter(col => CANONICAL_MIRROR_COLS.includes(col)).length,
        fieldCounts,
        sample: nextBatch.slice(0, options.sample).map(compact),
      },
    };

    if (options.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(`# Supabase Sync Status: ${status}`);
    console.log('');
    console.log(`Generated: ${payload.generatedAt}`);
    console.log(`Repo: \`${root}\``);
    console.log(`Window: last ${options.hours}h`);
    console.log('');
    console.log('## Checkpoint');
    if (checkpoint) {
      console.log(`- path: \`${options.checkpoint}\``);
      console.log(`- last_enriched_at: ${checkpoint.lastEnrichedAt}`);
      console.log(`- id: ${checkpoint.id}`);
    } else {
      console.log(`- path: \`${options.checkpoint}\``);
      console.log('- state: missing');
    }
    console.log('');
    console.log('## Summary');
    console.log(`- branch/head: \`${git.branch}\` / \`${git.head}\``);
    console.log(`- enriched in window: ${payload.summary.enriched_in_window}`);
    console.log(`- classified in window: ${payload.summary.classified_in_window}`);
    console.log(`- pending after checkpoint: ${payload.summary.pending_after_checkpoint}`);
    console.log(`- latest local last_enriched_at: ${payload.summary.latest_local_enriched_at || ''}`);
    console.log(`- last scheduled run: ${payload.lastRun?.state || 'not recorded'}`);
    if (payload.lastRun?.finished_at) console.log(`- last scheduled run finished: ${payload.lastRun.finished_at}`);
    if (payload.lastRun?.reason) console.log(`- last scheduled run reason: ${payload.lastRun.reason}`);
    console.log('');
    console.log('## Sync Boundary');
    console.log(`- target table: \`${payload.syncBoundary.targetTable}\``);
    console.log(`- local-only tables: ${payload.syncBoundary.localOnlyTables.map(tableName => `\`${tableName}\``).join(', ')}`);
    console.log('');
    console.log('## Low-I/O Bulk Sync');
    console.log(`- publication readiness: ${payload.publicationReadiness.status}`);
    console.log(`- publication detail: ${payload.publicationReadiness.reason}`);
    console.log(`- lifecycle schema: ${payload.lifecycleRemoteSchema.state}`);
    console.log(`- lifecycle detail: ${payload.lifecycleRemoteSchema.detail}`);
    console.log(`- RPC: \`${payload.bulkRpc.rpc}\``);
    console.log(`- state: ${payload.bulkRpc.state}`);
    console.log(`- configured: ${payload.bulkRpc.configured ? 'yes' : 'no'}`);
    console.log(`- available: ${payload.bulkRpc.available}`);
    console.log(`- detail: ${payload.bulkRpc.detail}`);
    console.log('');
    console.log('## Next Batch');
    console.log(`- local rows: ${payload.nextBatch.localRows}`);
    console.log(`- Supabase rows: ${payload.nextBatch.supabaseRows}`);
    console.log(`- rows that would update: ${payload.nextBatch.wouldUpdate}`);
    console.log(`- missing Supabase rows: ${payload.nextBatch.missingSupabaseRows}`);
    console.log(`- canonical classification mirror writes: ${payload.nextBatch.canonicalMirrorWrites}`);
    console.log('');
    console.log('## Field Counts');
    console.log(table(['value', 'count'], fieldCounts));
    console.log('');
    console.log('## Next Batch Sample');
    console.log(table(['id', 'name', 'state', 'google_place_id', 'style', 'price_range', 'style_confidence', 'last_enriched_at'], payload.nextBatch.sample));
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch(error => {
  const detail = summarizeSyncStatusError(error);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({
      status: 'UNAVAILABLE',
      publicationReadiness: {
        status: 'BLOCKED',
        reason: detail,
      },
      error: detail,
      read_only: true,
    }, null, 2));
  } else {
    console.error(`supabase-sync-status-report unavailable: ${detail}`);
  }
  process.exit(1);
});
