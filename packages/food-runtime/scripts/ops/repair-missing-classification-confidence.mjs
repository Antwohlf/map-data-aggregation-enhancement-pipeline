#!/usr/bin/env node
/**
 * Repair canonical rows that already have a valid style but no confidence.
 *
 * This is deliberately narrow: it never invents or changes style/price values
 * and never writes Supabase. The repaired confidence is inferred because the
 * existing style is not being re-established from a confirmed source here.
 */

import pg from 'pg';
import 'dotenv/config';
import { PIZZA_STYLES } from '../lib/pizza-style-taxonomy.mjs';

const STYLES = new Set(PIZZA_STYLES);

function parseArgs(argv) {
  const args = { hours: 24, limit: 1000, apply: false, json: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--hours') args.hours = Number.parseInt(argv[++i], 10);
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.help) return args;
  if (!Number.isInteger(args.hours) || args.hours <= 0) throw new Error('--hours must be positive');
  if (!Number.isInteger(args.limit) || args.limit <= 0 || args.limit > 5000) {
    throw new Error('--limit must be between 1 and 5000');
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/ops/repair-missing-classification-confidence.mjs [options]

Options:
  --hours <n>   Inspect rows enriched in the last n hours (default 24)
  --limit <n>   Maximum rows to inspect (default 1000, max 5000)
  --apply       Set missing confidence to inferred
  --json        Emit JSON

Dry-run is the default. Only local pizza_places is modified, never Supabase.
`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return printHelp();

  const client = new pg.Client({
    host: process.env.PGHOST || 'localhost',
    port: process.env.PGPORT ? Number.parseInt(process.env.PGPORT, 10) : 5432,
    database: process.env.PGDATABASE || 'pizza_enrichment',
    user: process.env.PGUSER || process.env.USER,
    password: process.env.PGPASSWORD || ''
  });

  await client.connect();
  try {
    const result = await client.query(`
      SELECT id, name, state, google_place_id, style, price_range,
             style_confidence, last_enriched_at
      FROM pizza_places
      WHERE last_enriched_at >= now() - ($1::text || ' hours')::interval
        AND google_place_id LIKE 'osm:%'
        AND style IS NOT NULL
        AND style_confidence IS NULL
      ORDER BY last_enriched_at DESC
      LIMIT $2
    `, [String(args.hours), args.limit]);

    const eligible = result.rows.filter(row => STYLES.has(row.style));
    const invalid = result.rows.length - eligible.length;
    let updated = [];
    if (args.apply && eligible.length) {
      const ids = eligible.map(row => row.id);
      const applied = await client.query(`
        UPDATE pizza_places
        SET style_confidence = 'inferred'
        WHERE id = ANY($1::bigint[])
          AND style IS NOT NULL
          AND style_confidence IS NULL
        RETURNING id, name, style, style_confidence
      `, [ids]);
      updated = applied.rows;
    }

    const payload = {
      mode: args.apply ? 'apply' : 'dry-run',
      hours: args.hours,
      rows_inspected: result.rows.length,
      eligible_rows: eligible.length,
      invalid_style_rows: invalid,
      rows_updated: updated.length,
      sample: (args.apply ? updated : eligible).slice(0, 25)
    };
    if (args.json) console.log(JSON.stringify(payload, null, 2));
    else {
      console.log('# Missing Classification Confidence Repair');
      console.log(`Mode: ${payload.mode}`);
      console.log(`Rows inspected: ${payload.rows_inspected}`);
      console.log(`Eligible rows: ${payload.eligible_rows}`);
      console.log(`Invalid-style rows skipped: ${payload.invalid_style_rows}`);
      console.log(`Rows updated: ${payload.rows_updated}`);
    }
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error(`repair-missing-classification-confidence failed: ${error.message || error}`);
  process.exit(1);
});
