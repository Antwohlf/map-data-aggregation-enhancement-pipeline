#!/usr/bin/env node
/**
 * Guarded local Postgres -> Supabase sync runner.
 *
 * Runs health, QA, readiness, dry-run, bounded write, and post-checks in
 * sequence. Write sync requires --apply; without it the script stops after
 * the dry-run.
 */

import { execFileSync } from 'child_process';
import { supabaseSyncProfile } from '../lib/supabase-sync-profiles.mjs';
import {
  bulkRpcStatusArgs,
  canApplyQaRepair,
  classificationQaArgs,
  classifierHealthArgs,
  syncReadinessArgs,
} from '../lib/guarded-sync-entity-boundary.mjs';

const NODE = process.execPath;

function parseArgs(argv) {
  const out = {
    entity: process.env.APIZZA_SYNC_ENTITY || 'pizza',
    ids: [],
    hours: 6,
    batch: 50,
    maxBatches: 1,
    checkpoint: 'scripts/.supabase-sync-checkpoint.json',
    sample: 10,
    insertMissingReviewedNew: false,
    apply: false,
    reconcile: false,
    concurrency: parseInt(process.env.APIZZA_SYNC_CONCURRENCY || '1', 10),
    bulkRpc: /^(1|true|yes)$/i.test(String(process.env.APIZZA_SYNC_BULK_RPC || '').trim()),
    lifecycleOnly: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--hours') out.hours = parseFloat(argv[++i]);
    else if (arg === '--entity') out.entity = String(argv[++i] || '').trim().toLowerCase();
    else if (arg === '--ids') out.ids = parseIds(argv[++i]);
    else if (arg === '--batch') out.batch = parseInt(argv[++i], 10);
    else if (arg === '--max-batches') out.maxBatches = parseInt(argv[++i], 10);
    else if (arg === '--checkpoint') out.checkpoint = argv[++i];
    else if (arg === '--reconcile') out.reconcile = true;
    else if (arg === '--concurrency') out.concurrency = parseInt(argv[++i], 10);
    else if (arg === '--bulk-rpc') out.bulkRpc = true;
    else if (arg === '--lifecycle-only') out.lifecycleOnly = true;
    else if (arg === '--sample') out.sample = parseInt(argv[++i], 10);
    else if (arg === '--insert-missing-reviewed-new') out.insertMissingReviewedNew = true;
    else if (arg === '--apply') out.apply = true;
    else if (arg === '--help') {
      console.log(`Usage: node scripts/ops/guarded-supabase-sync.mjs [options]

Options:
  --entity <pizza|taco> Select the configured sync profile (default pizza)
  --hours <n>        Recent enrichment window (default 6)
  --ids <a,b,c>      Sync only these local pizza_places ids
  --batch <n>        Batch size (default 50)
  --max-batches <n>  Maximum write batches (default 1)
  --checkpoint <p>   Checkpoint path (default scripts/.supabase-sync-checkpoint.json)
  --reconcile         Reconcile all eligible rows after an ID checkpoint
  --sample <n>       Readiness sample size (default 10)
  --insert-missing-reviewed-new
                      With --ids, insert missing rows only when local
                      place_sources proves reviewed_new_import
  --apply            Perform the bounded write after all gates pass
  --concurrency <n> Run independent Supabase writes concurrently
  --bulk-rpc        Apply updates through the installed low-I/O batch RPC
  --lifecycle-only  Publish only lifecycle fields for explicit IDs; skips classifier QA
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(out.hours) || out.hours <= 0) throw new Error('Invalid --hours');
  supabaseSyncProfile(out.entity);
  if (out.ids.length && out.checkpoint !== 'scripts/.supabase-sync-checkpoint.json') {
    throw new Error('--ids cannot be combined with --checkpoint');
  }
  if (out.reconcile && out.ids.length) throw new Error('--reconcile cannot be combined with --ids');
  if (!Number.isFinite(out.batch) || out.batch <= 0) throw new Error('Invalid --batch');
  if (!Number.isFinite(out.maxBatches) || out.maxBatches <= 0) throw new Error('Invalid --max-batches');
  if (!Number.isFinite(out.sample) || out.sample <= 0) throw new Error('Invalid --sample');
  if (!Number.isInteger(out.concurrency) || out.concurrency <= 0) throw new Error('Invalid --concurrency');
  if (out.lifecycleOnly) {
    if (!out.ids.length) throw new Error('--lifecycle-only requires explicit --ids');
    if (out.reconcile || out.insertMissingReviewedNew || out.checkpoint !== 'scripts/.supabase-sync-checkpoint.json') {
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

function run(command, args, { json = false, timeout = 120000 } = {}) {
  const stdout = execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  }).trim();

  if (!json) return stdout;
  return JSON.parse(stdout);
}

function step(title) {
  console.log('');
  console.log(`## ${title}`);
}

function assertState(label, actual, allowed = ['OK']) {
  if (!allowed.includes(actual)) {
    throw new Error(`${label} gate failed: ${actual}`);
  }
}

function blockingClassifierHealthIssues(health) {
  return (health?.health?.issues || []).filter(issue => !/^(Ollama(?: tunnel)?|laptop Ollama tunnel) unavailable:/i.test(issue));
}

function syncArgs(options, { dryRun = false } = {}) {
  const args = [
    'scripts/sync-local-to-supabase.mjs',
    '--entity', options.entity,
    '--batch', String(options.batch),
    '--max-batches', String(options.maxBatches),
    '--concurrency', String(options.concurrency),
  ];
  if (options.ids.length) {
    args.push('--ids', options.ids.join(','));
  } else if (options.reconcile) {
    args.push('--reconcile', '--checkpoint', options.checkpoint);
  } else {
    args.push(
      '--changed-since-hours', String(options.hours),
      '--only-classified',
      '--checkpoint', options.checkpoint,
    );
  }
  if (dryRun) args.push('--dry-run');
  if (options.insertMissingReviewedNew) args.push('--insert-missing-reviewed-new');
  if (options.bulkRpc) args.push('--bulk-rpc');
  if (options.lifecycleOnly) args.push('--lifecycle-only');
  return args;
}

function qaHardIssueIsRepairable(qa) {
  const repairable = qa.flags?.styleWithoutConfidence?.length || 0;
  return repairable > 0 && Object.entries(qa.flags || {}).every(([name, rows]) => {
    if (name === 'styleWithoutConfidence') return true;
    return rows.length === 0 || ![
      'invalidValues',
      'confidenceWithoutStyle',
      'chainMismatches'
    ].includes(name);
  });
}

function runQaWithRepair(options) {
  let qa = run(NODE, classificationQaArgs(options), { json: true });
  for (let attempt = 0; attempt < 3 && canApplyQaRepair(options) && qa.state === 'FAIL' && !options.ids.length && qaHardIssueIsRepairable(qa); attempt++) {
    console.log(`QA found ${qa.flags.styleWithoutConfidence.length} missing-confidence rows during concurrent processing; repairing and retrying.`);
    const repair = run(NODE, [
      'scripts/ops/repair-missing-classification-confidence.mjs',
      '--hours', String(options.hours),
      '--limit', '5000',
      '--apply',
      '--json',
    ], { json: true });
    console.log(`confidence repair: updated=${repair.rows_updated}`);
    qa = run(NODE, classificationQaArgs(options), { json: true });
  }
  return qa;
}

function verifyBulkRpc(options) {
  if (!options.bulkRpc) return null;

  const report = run(NODE, bulkRpcStatusArgs(options), { json: true });
  const capability = report.bulkRpc || {};
  console.log(`bulk_rpc=${capability.state || 'unknown'}, available=${capability.available ?? 'unknown'}`);
  if (capability.state !== 'ready') {
    throw new Error(`bulk RPC gate failed: ${capability.detail || 'the configured bulk RPC is not ready'}`);
  }
  return capability;
}

async function main() {
  const options = parseArgs(process.argv);
  const startedAt = new Date().toISOString();

  console.log('# Guarded Supabase Sync');
  console.log('');
  console.log(`Started: ${startedAt}`);
  console.log(`Mode: ${options.apply ? 'apply' : 'dry-run only'}`);
  console.log(`Scope: ${options.ids.length ? `ids=${options.ids.join(',')}` : `last ${options.hours}h classified checkpoint window`}`);
  console.log(`Batch: ${options.batch}, max_batches=${options.maxBatches}`);
  console.log(`Checkpoint: ${options.ids.length ? 'none (id-scoped)' : options.checkpoint}`);
  if (options.reconcile) console.log('Mode: ID-based reconciliation');
  console.log(`Insert missing reviewed-new: ${options.insertMissingReviewedNew ? 'yes' : 'no'}`);
  if (options.lifecycleOnly) console.log('Scope: lifecycle-only; no classifier or enrichment fields are eligible');

  step('Health Gate');
  const health = run(NODE, classifierHealthArgs(options.entity), { json: true });
  console.log(`state=${health.health.state}, completed_last_window=${health.queue?.recent?.completed ?? 'n/a'}, failed_last_window=${health.queue?.recent?.failed ?? 'n/a'}`);
  // Sync consumes already-classified local rows and never calls Ollama. A
  // transient inference/tunnel probe failure must not strand an otherwise
  // safe publication batch, while queue, Postgres, worker, and integrity
  // failures still block the write.
  const blockingIssues = blockingClassifierHealthIssues(health);
  const toleratedIssues = (health.health.issues || []).filter(issue => !blockingIssues.includes(issue));
  if (toleratedIssues.length) {
    console.log(`health warnings do not block sync: ${JSON.stringify(toleratedIssues)}`);
  }
  if (blockingIssues.length) {
    throw new Error(`health gate failed: ${JSON.stringify(blockingIssues)}`);
  }
  if (health.health.state !== 'OK' && !toleratedIssues.length) {
    console.log(`health warnings do not block sync: ${JSON.stringify(health.health.warnings || [])}`);
  }

  if (options.lifecycleOnly) {
    console.log('\n## QA Gate\nSkipped: lifecycle-only scope cannot modify classifier fields.');
  } else {
    step('QA Gate');
    const qa = runQaWithRepair(options);
    console.log(`state=${qa.state}, hard_issues=${qa.issueCount}, soft_warnings=${qa.warningCount}, inspected=${qa.totals.inspected}`);
    // Warnings are reported for review but do not block safe sync; hard issues
    // remain represented by FAIL and still stop the write.
    assertState('classification QA', qa.state, ['OK', 'WARN']);
  }

  step('Readiness Gate');
  const readiness = run(NODE, syncReadinessArgs(options), { json: true });
  console.log(`state=${readiness.state}, would_update=${readiness.totals.wouldUpdate}, missing=${readiness.totals.missingSupabaseRows}, canonical_mirror_writes=${readiness.totals.canonicalMirrorWrites}`);
  const allowsReviewedNewInserts = options.insertMissingReviewedNew;
  const missingRowsOnlyWarning = readiness.state === 'WARN'
    && readiness.totals.missingSupabaseRows > 0;
  assertState('readiness', readiness.state, allowsReviewedNewInserts || missingRowsOnlyWarning ? ['OK', 'WARN'] : ['OK']);
  if (missingRowsOnlyWarning && !allowsReviewedNewInserts) {
    console.log('Readiness warning is limited to local rows not yet present in Supabase; existing rows will sync and missing rows will be skipped for a later reviewed insert or retry.');
  }
  if (readiness.totals.missingSupabaseRows > 0 && !allowsReviewedNewInserts && !missingRowsOnlyWarning) {
    throw new Error('readiness gate failed: missing Supabase rows');
  }
  // Reconciliation must scan past protected/already-current rows so its ID
  // checkpoint can advance to later rows that may still need updates.
  if (!options.reconcile && readiness.totals.wouldUpdate === 0 && readiness.totals.missingSupabaseRows === 0) {
    console.log('No rows to update; stopping cleanly without requiring the bulk RPC.');
    return;
  }

  // Check the expensive/required publication capability only after readiness
  // proves there is work to publish. This keeps idle launchd runs healthy and
  // still prevents any real write from falling back to row-level I/O.
  if (options.bulkRpc) {
    step('Bulk RPC Gate');
    verifyBulkRpc(options);
  }

  step('Dry Run');
  const syncTimeout = options.reconcile ? 600000 : 120000;
  const dryRunOutput = run(NODE, syncArgs(options, { dryRun: true }), { timeout: syncTimeout });
  console.log(dryRunOutput);

  if (!options.apply) {
    console.log('');
    console.log('Dry-run mode complete. Re-run with --apply to write.');
    return;
  }

  step('Write');
  const writeOutput = run(NODE, syncArgs(options), { timeout: syncTimeout });
  console.log(writeOutput);

  step('Post Health Gate');
  const postHealth = run(NODE, classifierHealthArgs(options.entity), { json: true });
  console.log(`state=${postHealth.health.state}, completed_last_window=${postHealth.queue?.recent?.completed ?? 'n/a'}, failed_last_window=${postHealth.queue?.recent?.failed ?? 'n/a'}`);
  if (postHealth.health.issues?.length) {
    throw new Error(`post health gate failed: ${JSON.stringify(postHealth.health.issues)}`);
  }
  if (postHealth.health.state !== 'OK') {
    console.log(`post health warnings do not block sync: ${JSON.stringify(postHealth.health.warnings || [])}`);
  }

  if (options.lifecycleOnly) {
    console.log('\n## Post QA Gate\nSkipped: lifecycle-only scope cannot modify classifier fields.');
  } else {
    step('Post QA Gate');
    const postQa = runQaWithRepair(options);
    console.log(`state=${postQa.state}, hard_issues=${postQa.issueCount}, soft_warnings=${postQa.warningCount}, inspected=${postQa.totals.inspected}`);
    assertState('post classification QA', postQa.state, ['OK', 'WARN']);
  }

  console.log('');
  console.log(`Completed: ${new Date().toISOString()}`);
}

main().catch(error => {
  console.error(`guarded-supabase-sync failed: ${error.message || error}`);
  process.exit(1);
});
