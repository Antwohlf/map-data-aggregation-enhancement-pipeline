#!/usr/bin/env node
/**
 * Verify reviewed-new source imports are internally consistent.
 *
 * This is read-only. It checks that local canonical rows imported from
 * accepted likely-new review rows still have matching place_sources provenance
 * and source_review_queue links before any guarded Supabase publish.
 */

import pg from 'pg';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const ENTITY_TABLES = {
  pizza: 'pizza_places',
  taco: 'taco_places',
};

function parseArgs(argv) {
  const args = {
    entity: 'pizza',
    ids: [],
    limit: 1000,
    json: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--entity') args.entity = argv[++i];
    else if (arg === '--ids') args.ids = parseIds(argv[++i]);
    else if (arg === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (arg === '--json') args.json = true;
    else if (arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!ENTITY_TABLES[args.entity]) throw new Error('Invalid --entity. Use pizza or taco.');
  if (!Number.isFinite(args.limit) || args.limit <= 0 || args.limit > 10000) {
    throw new Error('Invalid --limit. Use 1-10000.');
  }
  return args;
}

function parseIds(value) {
  const ids = String(value || '')
    .split(',')
    .map(item => Number(item.trim()))
    .filter(id => Number.isInteger(id) && id > 0);
  if (!ids.length) throw new Error('Invalid --ids');
  return [...new Set(ids)];
}

function printHelp() {
  console.log(`Usage: node scripts/ops/verify-reviewed-new-imports.mjs [options]

Options:
  --entity <pizza|taco>      Entity type (default pizza)
  --ids <a,b,c>              Optional canonical place ids to verify
  --limit <n>                Max reviewed-new imports to inspect (default 1000)
  --json                     Emit JSON instead of Markdown

Read-only. Verifies that reviewed_new_import place_sources rows match local
canonical rows and linked source_review_queue rows.
`);
}

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  const txt = readFileSync(path, 'utf8');
  for (const line of txt.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    out[key] = value;
  }
  return out;
}

function dbConfig() {
  const env = {
    ...loadEnvFile(resolve(process.cwd(), '.env')),
    ...loadEnvFile(resolve(process.cwd(), '.env.local')),
    ...process.env,
  };

  return {
    host: env.LOCAL_DB_HOST || env.PGHOST || 'localhost',
    port: parseInt(env.LOCAL_DB_PORT || env.PGPORT || '5432', 10),
    database: env.LOCAL_DB_NAME || env.PGDATABASE || 'pizza_enrichment',
    user: env.LOCAL_DB_USER || env.PGUSER || process.env.USER,
    password: env.LOCAL_DB_PASSWORD || env.PGPASSWORD || '',
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

async function tableExists(client, tableName) {
  const result = await client.query(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = $1
    ) AS exists
  `, [tableName]);
  return Boolean(result.rows[0]?.exists);
}

function issueRows(rows) {
  return rows.filter(row => row.issue_count > 0);
}

async function loadReviewedNewRows(client, args) {
  const tableName = ENTITY_TABLES[args.entity];
  const filters = [
    'ps.entity_type = $1',
    "ps.match_method = 'reviewed_new_import'",
  ];
  const values = [args.entity];

  if (args.ids.length) {
    values.push(args.ids);
    filters.push(`ps.place_id = ANY($${values.length}::int[])`);
  }

  values.push(args.limit);
  const result = await client.query(`
    SELECT
      ps.place_id,
      ps.source,
      ps.source_id,
      ps.data,
      p.id AS canonical_place_id,
      p.name AS canonical_name,
      p.google_place_id,
      srq.id AS review_id,
      srq.status AS review_status,
      srq.decision AS review_decision,
      srq.canonical_place_id AS review_canonical_place_id,
      srq.source_name AS review_source_name,
      srq.report_file,
      (
        CASE WHEN p.id IS NULL THEN 1 ELSE 0 END +
        CASE WHEN srq.id IS NULL THEN 1 ELSE 0 END +
        CASE WHEN p.id IS NOT NULL AND p.id <> ps.place_id THEN 1 ELSE 0 END +
        CASE WHEN srq.id IS NOT NULL AND srq.canonical_place_id <> ps.place_id THEN 1 ELSE 0 END +
        CASE WHEN srq.id IS NOT NULL AND srq.status <> 'linked' THEN 1 ELSE 0 END +
        CASE WHEN srq.id IS NOT NULL AND srq.decision <> 'imported_new' THEN 1 ELSE 0 END +
        CASE WHEN p.google_place_id IS DISTINCT FROM (ps.source || ':' || ps.source_id) THEN 1 ELSE 0 END +
        CASE WHEN p.name IS DISTINCT FROM (ps.data #>> '{imported_place,name}') THEN 1 ELSE 0 END +
        CASE WHEN (ps.data #>> '{imported_place,id}')::int IS DISTINCT FROM ps.place_id THEN 1 ELSE 0 END
      ) AS issue_count
    FROM place_sources ps
    LEFT JOIN ${tableName} p
      ON p.id = ps.place_id
    LEFT JOIN source_review_queue srq
      ON srq.entity_type = ps.entity_type
     AND srq.source = ps.source
     AND ps.source_id = CASE
       WHEN srq.source = 'osm' THEN regexp_replace(srq.source_id, '^osm:', '')
       ELSE ps.source_id
     END
     AND srq.id = NULLIF(ps.data #>> '{review,queue_id}', '')::bigint
     AND srq.review_kind = 'likely_new'
    WHERE ${filters.join('\n      AND ')}
    ORDER BY ps.place_id
    LIMIT $${values.length}
  `, values);

  return result.rows;
}

async function linkedReviewRowsWithoutProvenance(client, args) {
  const tableName = ENTITY_TABLES[args.entity];
  const values = [args.entity];
  const filters = [
    'srq.entity_type = $1',
    "srq.review_kind = 'likely_new'",
    "srq.status = 'linked'",
    "srq.decision = 'imported_new'",
    'ps.id IS NULL',
  ];
  if (args.ids.length) {
    values.push(args.ids);
    filters.push(`srq.canonical_place_id = ANY($${values.length}::int[])`);
  }
  values.push(args.limit);
  const result = await client.query(`
    SELECT
      srq.id AS review_id,
      srq.canonical_place_id,
      srq.source,
      srq.source_id,
      srq.source_name,
      p.name AS canonical_name
    FROM source_review_queue srq
    LEFT JOIN ${tableName} p
      ON p.id = srq.canonical_place_id
    LEFT JOIN place_sources ps
     ON ps.entity_type = srq.entity_type
     AND ps.source = srq.source
     AND ps.source_id = CASE
       WHEN srq.source = 'osm' THEN regexp_replace(srq.source_id, '^osm:', '')
       ELSE srq.source_id
     END
     AND ps.place_id = srq.canonical_place_id
     -- A reviewed-new decision may reuse evidence that was already attached
     -- during source matching. Identity and place linkage are the invariant;
     -- the original match_method remains historical provenance.
    WHERE ${filters.join('\n      AND ')}
    ORDER BY srq.canonical_place_id
    LIMIT $${values.length}
  `, values);

  return result.rows;
}

function outputReport({ args, rows, issues, missingProvenance }) {
  const payload = {
    generated_at: new Date().toISOString(),
    entity: args.entity,
    ids: args.ids,
    inspected: rows.length,
    issue_rows: issues.length,
    linked_reviews_missing_provenance: missingProvenance.length,
    status: issues.length || missingProvenance.length ? 'failed' : 'ok',
    issues,
    missing_provenance: missingProvenance,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log('# Reviewed-New Import Verification');
  console.log('');
  console.log(`Entity: ${args.entity}`);
  console.log(`Inspected reviewed-new imports: ${rows.length}`);
  console.log(`Issue rows: ${issues.length}`);
  console.log(`Linked reviews missing provenance: ${missingProvenance.length}`);
  console.log(`Status: ${payload.status}`);
  console.log('');
  if (issues.length) {
    console.log('## Issue Rows');
    console.log(table([
      'place_id',
      'canonical_name',
      'google_place_id',
      'review_id',
      'review_status',
      'review_decision',
      'review_canonical_place_id',
      'issue_count',
    ], issues.slice(0, 50)));
    console.log('');
  }
  if (missingProvenance.length) {
    console.log('## Linked Reviews Missing Provenance');
    console.log(table([
      'review_id',
      'canonical_place_id',
      'source',
      'source_id',
      'source_name',
      'canonical_name',
    ], missingProvenance.slice(0, 50)));
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const client = new pg.Client(dbConfig());
  await client.connect();

  try {
    if (!(await tableExists(client, ENTITY_TABLES[args.entity]))) {
      throw new Error(`${ENTITY_TABLES[args.entity]} table does not exist.`);
    }
    if (!(await tableExists(client, 'place_sources'))) {
      throw new Error('place_sources table does not exist.');
    }
    if (!(await tableExists(client, 'source_review_queue'))) {
      throw new Error('source_review_queue table does not exist.');
    }

    const rows = await loadReviewedNewRows(client, args);
    const issues = issueRows(rows);
    const missingProvenance = await linkedReviewRowsWithoutProvenance(client, args);
    outputReport({ args, rows, issues, missingProvenance });

    if (issues.length || missingProvenance.length) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error(`verify-reviewed-new-imports failed: ${error.message || error}`);
  process.exit(1);
});
