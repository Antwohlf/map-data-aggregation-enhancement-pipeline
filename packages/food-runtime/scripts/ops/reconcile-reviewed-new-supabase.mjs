#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import pg from 'pg';
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const options = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const options = { limit: 25, apply: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--limit') options.limit = Number(argv[++index]);
    else if (/^\d+$/.test(arg)) options.limit = Number(arg);
    else if (arg === '--help') {
      console.log('Usage: node scripts/ops/reconcile-reviewed-new-supabase.mjs [--limit n] [--apply] [--json]');
      console.log('Default mode is read-only. --apply is required to insert missing reviewed-new rows.');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 250) {
    throw new Error('--limit must be an integer between 1 and 250');
  }
  return options;
}
const pgClient = new pg.Client({ host: 'localhost', database: 'pizza_enrichment', user: process.env.PGUSER || process.env.USER });
await pgClient.connect();
const { rows } = await pgClient.query(`
  SELECT DISTINCT p.id, p.last_enriched_at
  FROM pizza_places p
  LEFT JOIN place_sources ps
    ON ps.entity_type='pizza'
   AND ps.place_id=p.id
   AND ps.match_method='reviewed_new_import'
  LEFT JOIN source_review_queue srq
    ON srq.entity_type='pizza'
   AND srq.canonical_place_id=p.id
   AND srq.status IN ('accepted', 'linked')
   AND srq.decision='imported_new'
  WHERE (ps.place_id IS NOT NULL OR srq.canonical_place_id IS NOT NULL)
    AND p.last_enriched_at IS NOT NULL
    AND (p.style IS NOT NULL OR p.price_range IS NOT NULL OR p.style_confidence IS NOT NULL)
  -- Do not inspect the first canonical IDs only. New reviewed imports are
  -- appended at the high end of the ID range and otherwise never reach the
  -- reconciliation query.
  ORDER BY p.last_enriched_at DESC, p.id DESC
`);
await pgClient.end();

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
);
const ids = rows.map(row => row.id);
if (!ids.length) { console.log('reviewed-new Supabase reconciliation: no classified local rows'); process.exit(0); }
const present = new Set();
for (let index = 0; index < ids.length; index += 500) {
  const chunk = ids.slice(index, index + 500);
  const { data, error } = await supabase.from('pizza_places').select('id').in('id', chunk);
  if (error) throw error;
  for (const row of data || []) present.add(Number(row.id));
}
const missingIds = ids.filter(id => !present.has(Number(id)));
const missing = missingIds.slice(0, options.limit);
const result = {
  candidate_count: ids.length,
  missing_count: missingIds.length,
  selected_count: missing.length,
  missing_ids: missing,
  mode: options.apply ? 'apply' : 'dry-run',
};
if (options.json) console.log(JSON.stringify(result));
else {
  console.log(`reviewed-new Supabase reconciliation: ${ids.length} classified candidates, ${missingIds.length} missing`);
  if (missing.length) console.log(`missing ids: ${missing.join(',')}`);
}
if (!missing.length || !options.apply) process.exit(0);

console.log(`reviewed-new Supabase reconciliation: inserting ${missing.length} rows`);
execFileSync(process.execPath, [
  'scripts/ops/guarded-supabase-sync.mjs',
  '--ids', missing.join(','),
  '--batch', String(missing.length),
  '--max-batches', '1',
  '--insert-missing-reviewed-new',
  '--apply',
], { stdio: 'inherit', timeout: 1200000 });
