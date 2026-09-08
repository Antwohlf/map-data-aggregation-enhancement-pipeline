#!/usr/bin/env node
/**
 * Import source review JSON artifacts into a durable local Postgres queue.
 *
 * This does not create canonical places or write place_sources. It only records
 * ambiguous and likely-new source rows so humans/tools can review them later.
 */

import pg from 'pg';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

function parseArgs(argv) {
  const args = {
    inputDir: 'reports/source-review',
    inputFiles: [],
    applySchema: false,
    apply: false,
    entity: null,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--input-dir') args.inputDir = argv[++i];
    else if (arg === '--input-file') args.inputFiles.push(argv[++i]);
    else if (arg === '--input-files') args.inputFiles.push(...argv[++i].split(',').map(item => item.trim()).filter(Boolean));
    else if (arg === '--entity') args.entity = argv[++i];
    else if (arg === '--apply-schema') args.applySchema = true;
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (args.entity && !['pizza', 'taco'].includes(args.entity)) {
    throw new Error('Invalid --entity. Use pizza or taco.');
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/ops/import-source-review-queue.mjs [options]

Options:
  --input-dir <dir>  Directory containing *-review.json files
                     (default reports/source-review)
  --input-file <f>   Import one review JSON file
  --input-files <a,b>
                     Import comma-separated review JSON files
  --entity <pizza|taco>
                     Optional entity filter
  --apply-schema     Create source_review_queue table/indexes if missing
  --apply            Upsert review rows into source_review_queue

Default mode is dry-run. This never writes pizza_places, taco_places,
place_sources, or Supabase.
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

function readReports(inputDir, entityFilter, inputFiles = []) {
  const absDir = resolve(process.cwd(), inputDir);
  const fileNames = inputFiles.length
    ? inputFiles
    : (existsSync(absDir) ? readdirSync(absDir).filter(name => name.endsWith('-review.json')).sort() : []);

  const reports = [];
  for (const file of fileNames) {
    const absFile = resolve(process.cwd(), file);
    const filePath = existsSync(absFile) ? absFile : join(absDir, file);
    if (!existsSync(filePath)) {
      throw new Error(`Review file not found: ${file}`);
    }
    const report = JSON.parse(readFileSync(filePath, 'utf8'));
    if (entityFilter && report.entity !== entityFilter) continue;
    reports.push({ file: filePath.startsWith(absDir) ? filePath.slice(absDir.length + 1) : file, report });
  }
  return reports;
}

function normalizeReviewRow({ file, report, kind, item }) {
  const nearest = item.nearest_place || {};
  const sourceId = item.source_id == null ? '' : String(item.source_id).trim();
  if (!sourceId) return null;

  return {
    entity_type: report.entity,
    review_kind: kind,
    source: item.source || report.source,
    source_id: sourceId,
    source_name: item.source_name || null,
    source_url: item.source_url || null,
    source_data: item.source_data || {},
    nearest_place_id: nearest.id || null,
    nearest_google_place_id: nearest.google_place_id || null,
    nearest_place_name: nearest.name || null,
    nearest_distance_m: nearest.distance_m ?? null,
    nearest_name_score: nearest.name_score ?? null,
    review_reason: nearest.review_reason || null,
    report_file: file,
    report_generated_at: report.generated_at || null,
  };
}

function reviewRows(reports) {
  const rows = [];
  for (const { file, report } of reports) {
    for (const item of report.ambiguous || []) {
      const row = normalizeReviewRow({ file, report, kind: 'ambiguous', item });
      if (row) rows.push(row);
    }
    for (const item of report.likely_new || []) {
      const row = normalizeReviewRow({ file, report, kind: 'likely_new', item });
      if (row) rows.push(row);
    }
  }
  return rows;
}

async function tableExists(client) {
  const result = await client.query(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'source_review_queue'
    ) AS exists
  `);
  return Boolean(result.rows[0]?.exists);
}

async function applySchema(client) {
  const sql = readFileSync(resolve(process.cwd(), 'scripts/enrichment/source-review-queue-schema.sql'), 'utf8');
  await client.query(sql);
}

async function existingCounts(client) {
  if (!(await tableExists(client))) return [];
  const result = await client.query(`
    SELECT entity_type, review_kind, status, COUNT(*)::int AS count
    FROM source_review_queue
    GROUP BY entity_type, review_kind, status
    ORDER BY entity_type, review_kind, status
  `);
  return result.rows;
}

async function upsertRows(client, rows) {
  let written = 0;

  for (const row of rows) {
    const result = await client.query(`
      INSERT INTO source_review_queue (
        entity_type,
        review_kind,
        source,
        source_id,
        source_name,
        source_url,
        source_data,
        nearest_place_id,
        nearest_google_place_id,
        nearest_place_name,
        nearest_distance_m,
        nearest_name_score,
        review_reason,
        report_file,
        report_generated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (entity_type, source, source_id, review_kind) DO UPDATE SET
        source_name = EXCLUDED.source_name,
        source_url = EXCLUDED.source_url,
        source_data = EXCLUDED.source_data,
        nearest_place_id = EXCLUDED.nearest_place_id,
        nearest_google_place_id = EXCLUDED.nearest_google_place_id,
        nearest_place_name = EXCLUDED.nearest_place_name,
        nearest_distance_m = EXCLUDED.nearest_distance_m,
        nearest_name_score = EXCLUDED.nearest_name_score,
        review_reason = EXCLUDED.review_reason,
        report_file = EXCLUDED.report_file,
        report_generated_at = EXCLUDED.report_generated_at,
        updated_at = NOW()
      WHERE source_review_queue.status = 'pending'
    `, [
      row.entity_type,
      row.review_kind,
      row.source,
      row.source_id,
      row.source_name,
      row.source_url,
      JSON.stringify(row.source_data),
      row.nearest_place_id,
      row.nearest_google_place_id,
      row.nearest_place_name,
      row.nearest_distance_m,
      row.nearest_name_score,
      row.review_reason,
      row.report_file,
      row.report_generated_at,
    ]);
    written += result.rowCount;
  }

  return written;
}

async function main() {
  const args = parseArgs(process.argv);
  const reports = readReports(args.inputDir, args.entity, args.inputFiles);
  const rows = reviewRows(reports);
  const byKind = rows.reduce((acc, row) => {
    acc[row.review_kind] = (acc[row.review_kind] || 0) + 1;
    return acc;
  }, {});
  const bySource = rows.reduce((acc, row) => {
    const key = `${row.entity_type}|${row.source}|${row.review_kind}`;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const client = new pg.Client(dbConfig());
  await client.connect();

  try {
    if (args.applySchema) {
      await applySchema(client);
    }

    const exists = await tableExists(client);
    if (args.apply && !exists) {
      throw new Error('source_review_queue table does not exist. Run with --apply-schema first.');
    }

    const before = await existingCounts(client);
    const written = args.apply ? await upsertRows(client, rows) : 0;
    const after = await existingCounts(client);

    console.log(`# Source Review Queue ${args.apply ? 'Import' : 'Dry Run'}`);
    console.log('');
    console.log(`Input directory: \`${args.inputDir}\``);
    if (args.inputFiles.length) console.log(`Input files: ${args.inputFiles.join(', ')}`);
    console.log(`Reports read: ${reports.length}`);
    console.log(`Review rows found: ${rows.length}`);
    console.log(`source_review_queue exists: ${exists ? 'yes' : args.applySchema ? 'yes' : 'no'}`);
    console.log(`Rows written: ${written}`);
    console.log('');
    console.log('## Input Rows by Kind');
    console.log(table(['kind', 'count'], Object.entries(byKind).map(([kind, count]) => ({ kind, count }))));
    console.log('');
    console.log('## Input Rows by Source');
    console.log(table(
      ['entity', 'source', 'kind', 'count'],
      Object.entries(bySource).map(([key, count]) => {
        const [entity, source, kind] = key.split('|');
        return { entity, source, kind, count };
      })
    ));
    console.log('');
    console.log('## Queue Counts Before');
    console.log(table(['entity_type', 'review_kind', 'status', 'count'], before));
    console.log('');
    console.log('## Queue Counts After');
    console.log(table(['entity_type', 'review_kind', 'status', 'count'], after));
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error(`import-source-review-queue failed: ${error.message || error}`);
  process.exit(1);
});
