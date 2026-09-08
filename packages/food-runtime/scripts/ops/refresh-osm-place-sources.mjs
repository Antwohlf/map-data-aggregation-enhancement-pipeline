#!/usr/bin/env node

/**
 * Refresh local OSM evidence for already-linked canonical places.
 *
 * This deliberately does not create places, alter review decisions, promote
 * canonical fields, or contact Supabase. It only refreshes exact OSM source
 * IDs that already exist in place_sources.
 */

import pg from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();

function loadEnv(path) {
  if (!existsSync(path)) return {};
  return Object.fromEntries(readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line && !line.trim().startsWith('#') && line.includes('='))
    .map(line => {
      const [key, ...rest] = line.split('=');
      return [key.trim(), rest.join('=').trim().replace(/^['"]|['"]$/g, '')];
    }));
}

function dbConfig() {
  const env = {
    ...loadEnv(resolve(ROOT, '.env')),
    ...loadEnv(resolve(ROOT, '.env.local')),
    ...process.env,
  };
  return {
    host: env.LOCAL_DB_HOST || env.PGHOST || 'localhost',
    port: Number(env.LOCAL_DB_PORT || env.PGPORT || 5432),
    database: env.LOCAL_DB_NAME || env.PGDATABASE || 'pizza_enrichment',
    user: env.LOCAL_DB_USER || env.PGUSER || process.env.USER,
    password: env.LOCAL_DB_PASSWORD || env.PGPASSWORD || '',
  };
}

function parseArgs(argv) {
  const out = { entity: 'pizza', input: null, states: [], maxUpdates: 1000, apply: false, json: false };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--entity') out.entity = argv[++index];
    else if (arg === '--input') out.input = argv[++index];
    else if (arg === '--states') out.states = String(argv[++index] || '').split(',').map(value => value.trim().toUpperCase()).filter(Boolean);
    else if (arg === '--max-updates') out.maxUpdates = Number(argv[++index]);
    else if (arg === '--apply') out.apply = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--help') {
      console.log('Usage: node scripts/ops/refresh-osm-place-sources.mjs --input <json> [--entity pizza|taco] [--states MI,NY] [--max-updates n] [--apply] [--json]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['pizza', 'taco'].includes(out.entity)) throw new Error('Invalid --entity.');
  if (!out.input) throw new Error('Missing --input.');
  if (!Number.isInteger(out.maxUpdates) || out.maxUpdates < 1) throw new Error('Invalid --max-updates.');
  return out;
}

function readRows(inputPath) {
  const payload = JSON.parse(readFileSync(resolve(ROOT, inputPath), 'utf8'));
  const rows = Array.isArray(payload) ? payload : payload?.rows;
  if (!Array.isArray(rows)) throw new Error('OSM input must be an array or an object with a rows array.');
  return rows;
}

function sourceIdFor(row) {
  const raw = String(row?.id || row?.source_id || '').trim();
  return raw.replace(/^osm:/i, '');
}

function normalizeRow(row) {
  const sourceId = sourceIdFor(row);
  if (!sourceId || !/^(node|way|relation)\/\d+$/.test(sourceId)) return null;
  const sourceUrl = String(row.source_url || `https://www.openstreetmap.org/${sourceId}`).trim();
  const sourceData = {
    ...row,
    source_id: sourceId,
    source_url: sourceUrl,
    website_url: row.website_url || row.website || null,
    state: row.state || row.region || null,
  };
  return { sourceId, sourceUrl, sourceData };
}

function print(payload, json) {
  if (json) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log(`# Refresh OSM Place Sources ${payload.mode}`);
    console.log(`Input rows: ${payload.inputRows}`);
    console.log(`Valid OSM rows: ${payload.validRows}`);
    console.log(`Existing links found: ${payload.existingLinks}`);
    console.log(`Rows refreshed: ${payload.refreshed}`);
    console.log(`Rows skipped by limit: ${payload.skippedByLimit}`);
    console.log('');
    console.log(payload.mode === 'dry-run'
      ? 'No local rows changed. Re-run with --apply to refresh exact existing OSM links.'
      : 'Only existing place_sources evidence was refreshed; no canonical places or Supabase rows were changed.');
  }
}

const args = parseArgs(process.argv);
const inputRows = readRows(args.input);
const normalized = inputRows.map(normalizeRow).filter(Boolean);
const uniqueRows = [...new Map(normalized.map(row => [row.sourceId, row])).values()];
const client = new pg.Client(dbConfig());

try {
  await client.connect();
  const existing = await client.query(`
    SELECT source_id, retrieved_at
    FROM place_sources
    WHERE entity_type = $1
      AND source = 'osm'
      AND source_id = ANY($2::text[])
      ${args.states.length ? `AND EXISTS (
        SELECT 1
        FROM ${args.entity === 'taco' ? 'taco_places' : 'pizza_places'} canonical
        WHERE canonical.id = place_sources.place_id
          AND UPPER(COALESCE(canonical.state, '')) = ANY($3::text[])
      )` : ''}
  `, args.states.length
    ? [args.entity, uniqueRows.map(row => row.sourceId), args.states]
    : [args.entity, uniqueRows.map(row => row.sourceId)]);
  const existingById = new Map(existing.rows.map(row => [row.source_id, row.retrieved_at]));
  const existingIds = new Set(existingById.keys());
  const candidates = uniqueRows
    .filter(row => existingIds.has(row.sourceId))
    // Always advance through the oldest evidence first. Without this order,
    // a bounded run would refresh the same prefix of a regional export forever.
    .sort((left, right) => (
      (Date.parse(existingById.get(left.sourceId)) || 0)
      - (Date.parse(existingById.get(right.sourceId)) || 0)
    ))
    .slice(0, args.maxUpdates);
  let refreshed = 0;

  if (args.apply && candidates.length) {
    await client.query('BEGIN');
    try {
      for (const row of candidates) {
        const result = await client.query(`
          UPDATE place_sources
          SET source_url = $3,
              data = $4::jsonb,
              retrieved_at = NOW(),
              updated_at = NOW()
          WHERE entity_type = $1
            AND source = 'osm'
            AND source_id = $2
        `, [args.entity, row.sourceId, row.sourceUrl, JSON.stringify(row.sourceData)]);
        refreshed += result.rowCount;
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  print({
    mode: args.apply ? 'apply' : 'dry-run',
    entity: args.entity,
    states: args.states,
    input: args.input,
    inputRows: inputRows.length,
    validRows: uniqueRows.length,
    existingLinks: existingIds.size,
    refreshed,
    skippedByLimit: Math.max(0, existingIds.size - candidates.length),
  }, args.json);
} finally {
  await client.end();
}
