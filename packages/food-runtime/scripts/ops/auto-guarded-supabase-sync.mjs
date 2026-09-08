#!/usr/bin/env node
/**
 * launchd-safe wrapper for guarded Supabase sync.
 *
 * The underlying guarded runner owns the real safety checks. This wrapper only
 * prevents overlapping scheduled runs and supplies conservative defaults.
 */

import { mkdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { makeSyncRunState, summarizeSyncFailure, syncRunStatePath, writeSyncRunState } from '../lib/supabase-sync-run-state.mjs';
import { supabaseSyncProfile } from '../lib/supabase-sync-profiles.mjs';
import { defaultSyncStatusFile } from '../lib/supabase-sync-status-file.mjs';

const LOCK_DIR = process.env.APIZZA_SYNC_LOCK_DIR || '/tmp/apizzamichigan/supabase-sync.lock';
const LOCK_MAX_AGE_MS = parseInt(process.env.APIZZA_SYNC_LOCK_MAX_AGE_MS || String(25 * 60 * 1000), 10);
const syncEntity = process.env.APIZZA_SYNC_ENTITY || 'pizza';
const STATUS_FILE = syncRunStatePath(process.env.APIZZA_SYNC_STATUS_FILE || defaultSyncStatusFile(syncEntity));

function parseArgs(argv) {
  const out = {
    entity: syncEntity,
    hours: process.env.APIZZA_SYNC_HOURS || '168',
    batch: process.env.APIZZA_SYNC_BATCH || '100',
    maxBatches: process.env.APIZZA_SYNC_MAX_BATCHES || '1',
    checkpoint: process.env.APIZZA_SYNC_CHECKPOINT || 'scripts/.supabase-sync-checkpoint.json',
    sample: process.env.APIZZA_SYNC_SAMPLE || '10',
    insertMissingReviewedNew: process.env.APIZZA_SYNC_INSERT_MISSING_REVIEWED_NEW === 'true',
    reconcileCheckpoint: process.env.APIZZA_SYNC_RECONCILE_CHECKPOINT || 'scripts/.supabase-reconcile-checkpoint.json',
    reconcileBatch: process.env.APIZZA_SYNC_RECONCILE_BATCH || process.env.APIZZA_SYNC_BATCH || '100',
    reconcileMaxBatches: process.env.APIZZA_SYNC_RECONCILE_MAX_BATCHES || '5',
    concurrency: process.env.APIZZA_SYNC_CONCURRENCY || '1',
    runReconciliation: process.env.APIZZA_SYNC_RUN_RECONCILIATION === 'true',
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--hours') out.hours = argv[++i];
    else if (arg === '--entity') out.entity = argv[++i];
    else if (arg === '--batch') out.batch = argv[++i];
    else if (arg === '--max-batches') out.maxBatches = argv[++i];
    else if (arg === '--checkpoint') out.checkpoint = argv[++i];
    else if (arg === '--sample') out.sample = argv[++i];
    else if (arg === '--bulk-rpc') out.bulkRpc = true;
    else if (arg === '--insert-missing-reviewed-new') out.insertMissingReviewedNew = true;
    else if (arg === '--reconcile-reviewed-new') out.runReconciliation = true;
    else if (arg === '--help') {
      console.log(`Usage: node scripts/ops/auto-guarded-supabase-sync.mjs [options]

Options mirror guarded-supabase-sync.mjs. This wrapper always applies the
bounded write after the guarded preflight checks pass.

Use --entity pizza|taco to select the configured publication profile. Taco
remains planning-only until its profile is explicitly enabled.

Reviewed-new reconciliation is opt-in because it scans a broader local and
remote set than the normal checkpointed sync. Use --reconcile-reviewed-new, or
set APIZZA_SYNC_RUN_RECONCILIATION=true, for an explicit maintenance run.
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  supabaseSyncProfile(out.entity);
  return out;
}

function lockAgeMs() {
  try {
    return Date.now() - statSync(LOCK_DIR).mtimeMs;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function acquireLock() {
  try {
    mkdirSync(LOCK_DIR, { recursive: false });
    writeFileSync(`${LOCK_DIR}/owner.json`, JSON.stringify({
      pid: process.pid,
      started_at: new Date().toISOString(),
    }, null, 2));
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const age = lockAgeMs();
      if (age !== null && Number.isFinite(LOCK_MAX_AGE_MS) && age > LOCK_MAX_AGE_MS) {
        console.log(`[recover] removing stale guarded Supabase sync lock; lock=${LOCK_DIR} age_ms=${Math.round(age)}`);
        releaseLock();
        return acquireLock();
      }
      return false;
    }
    throw error;
  }
}

function releaseLock() {
  rmSync(LOCK_DIR, { recursive: true, force: true });
}

const options = parseArgs(process.argv);
const startedAt = new Date().toISOString();

function saveRunState(state, { finishedAt = null, exitCode = null, reason = null } = {}) {
  writeSyncRunState(STATUS_FILE, makeSyncRunState({
    state,
    startedAt,
    finishedAt,
    exitCode,
    reason,
    options,
  }));
}

class SyncSkipped extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'SyncSkipped';
  }
}

function bulkSyncPreflight() {
  const result = spawnSync(process.execPath, [
    'scripts/ops/supabase-sync-status-report.mjs',
    '--entity', options.entity,
    '--require-bulk-rpc',
    '--json',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    timeout: 120000,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    // The status report emits structured JSON even when a read-only
    // dependency check is unavailable. Treat that as a safe skip rather than
    // surfacing a stack trace from a path that must never write when preflight
    // is uncertain.
    try {
      const unavailable = JSON.parse(result.stdout || '{}');
      const detail = unavailable.error || unavailable.publicationReadiness?.reason || result.stderr || 'read-only capability check unavailable';
      console.log(`[skip] bulk sync preflight unavailable; status=${unavailable.status || 'UNAVAILABLE'} detail=${detail}`);
      return false;
    } catch {
      throw new Error(`bulk sync capability check failed with status ${result.status ?? 1}: ${result.stderr || ''}`.trim());
    }
  }

  let report;
  try {
    report = JSON.parse(result.stdout || '{}');
  } catch (error) {
    throw new Error(`bulk sync capability check returned invalid JSON: ${error.message}`);
  }

  if (report.bulkRpc?.state !== 'ready') {
    console.log(`[skip] bulk sync unavailable; state=${report.bulkRpc?.state || 'unknown'} detail=${report.bulkRpc?.detail || 'no detail'}`);
    return false;
  }
  return true;
}

saveRunState('running');
let exitCode = 1;
let failureReason = null;
let lockAcquired = false;
try {
  // Do not repair local rows or open a write-sync lock when the remote bulk path
  // is not installed. The status report remains the authoritative alert surface.
  if (!bulkSyncPreflight()) {
    throw new SyncSkipped('bulk sync unavailable');
  }

  if (!acquireLock()) {
    const age = lockAgeMs();
    const reason = `another sync is already running; lock age_ms=${age === null ? 'unknown' : Math.round(age)}`;
    console.log(`[skip] guarded Supabase sync already running; lock=${LOCK_DIR} age_ms=${age === null ? 'unknown' : Math.round(age)}`);
    throw new SyncSkipped(reason);
  }
  lockAcquired = true;

  // This repair script is intentionally pizza-specific. Taco classification
  // writes confidence as part of the entity-aware classifier and must not
  // trigger unrelated pizza mutations from the taco scheduler.
  if (options.entity === 'pizza') {
    const confidenceRepair = spawnSync(process.execPath, [
      'scripts/ops/repair-missing-classification-confidence.mjs',
      '--hours', options.hours,
      '--limit', '5000',
      '--apply',
      '--json',
    ], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: process.env,
      timeout: 120000,
    });
    if (confidenceRepair.error) throw confidenceRepair.error;
    if (confidenceRepair.status !== 0) {
      throw new Error(`classification confidence repair failed with status ${confidenceRepair.status ?? 1}`);
    }
  } else {
    console.log(`[sync] skipped pizza-only confidence repair for entity=${options.entity}`);
  }

  if (options.runReconciliation) {
    const reconciliation = spawnSync(process.execPath, [
      'scripts/ops/reconcile-reviewed-new-supabase.mjs',
      '250',
      '--apply',
    ], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: process.env,
      timeout: 1200000,
    });
    if (reconciliation.error || reconciliation.status !== 0) {
      // This optional source-import pre-step must not suppress the main sync.
      // The guarded sync below has its own health/readiness gates and will stop
      // safely when Supabase itself is unavailable.
      console.warn(`reviewed-new reconciliation warning: ${reconciliation.error?.message || `status ${reconciliation.status ?? 1}`}`);
    }
  } else {
    console.log('[sync] reviewed-new reconciliation skipped; run explicitly when needed');
  }
  const result = spawnSync(process.execPath, [
    'scripts/ops/guarded-supabase-sync.mjs',
    '--entity', options.entity,
    '--hours', options.hours,
    '--batch', options.batch,
    '--max-batches', options.maxBatches,
    '--checkpoint', options.checkpoint,
    '--sample', options.sample,
    '--concurrency', options.concurrency,
    '--bulk-rpc',
    '--apply',
    ...(options.insertMissingReviewedNew ? ['--insert-missing-reviewed-new'] : []),
  ], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) throw result.error;
  exitCode = result.status ?? 1;

  if (exitCode === 0 && options.runReconciliation) {
    const reconciliation = spawnSync(process.execPath, [
      'scripts/ops/guarded-supabase-sync.mjs',
      '--reconcile',
      '--checkpoint', options.reconcileCheckpoint,
      '--batch', options.reconcileBatch,
      '--max-batches', options.reconcileMaxBatches,
      '--sample', options.sample,
      '--concurrency', options.concurrency,
      '--bulk-rpc',
      '--apply',
    ], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: process.env,
    });
    if (reconciliation.error) throw reconciliation.error;
    exitCode = reconciliation.status ?? 1;
  }
} catch (error) {
  if (error instanceof SyncSkipped) {
    exitCode = 0;
    failureReason = error.message;
  } else {
    failureReason = summarizeSyncFailure(error?.message || error);
    console.error(`[sync] failed: ${failureReason}`);
    exitCode = 1;
  }
} finally {
  if (lockAcquired) releaseLock();
}

saveRunState(failureReason && exitCode === 0 ? 'skipped' : exitCode === 0 ? 'succeeded' : 'failed', {
  finishedAt: new Date().toISOString(),
  exitCode,
  reason: failureReason || (exitCode === 0 ? 'bounded sync completed' : 'sync exited unsuccessfully'),
});

process.exit(exitCode);
