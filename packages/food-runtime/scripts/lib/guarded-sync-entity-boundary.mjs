import { supabaseSyncProfile } from './supabase-sync-profiles.mjs'

function checkedEntity(entity) {
  return supabaseSyncProfile(entity).entity
}

export function canApplyQaRepair(options) {
  return options.apply === true && checkedEntity(options.entity) === 'pizza'
}

export function classifierHealthArgs(entity) {
  return ['scripts/ops/classifier-health-report.mjs', '--entity', checkedEntity(entity), '--json']
}

export function classificationQaArgs(options) {
  const entity = checkedEntity(options.entity)
  return [
    'scripts/ops/classification-qa-report.mjs',
    '--entity', entity,
    ...(options.ids.length
      ? ['--ids', options.ids.join(',')]
      : ['--hours', String(options.hours), '--limit', '500']),
    '--sample', String(options.sample),
    '--json',
  ]
}

export function bulkRpcStatusArgs(options) {
  return [
    'scripts/ops/supabase-sync-status-report.mjs',
    '--entity', checkedEntity(options.entity),
    '--hours', String(options.hours),
    '--batch', '1',
    '--sample', '1',
    '--require-bulk-rpc',
    '--json',
  ]
}

export function syncReadinessArgs(options) {
  return [
    'scripts/ops/supabase-sync-readiness-report.mjs',
    '--entity', checkedEntity(options.entity),
    '--batch', String(options.batch),
    '--sample', String(options.sample),
    '--json',
    ...(options.lifecycleOnly ? ['--lifecycle-only'] : []),
    ...(options.ids.length
      ? ['--ids', options.ids.join(',')]
      : options.reconcile
        ? ['--reconcile', '--checkpoint', options.checkpoint]
        : ['--changed-since-hours', String(options.hours), '--only-classified', '--checkpoint', options.checkpoint]),
  ]
}
