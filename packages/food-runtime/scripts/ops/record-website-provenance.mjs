#!/usr/bin/env node
import pg from 'pg';
import { loadRuntimeEnvironment } from '../lib/runtime-environment.mjs';

function parseArgs(argv, env) {
  const options = { hours: 2, entity: String(env.APIZZA_SYNC_ENTITY || 'pizza').toLowerCase(), ids: [], dryRun: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/ops/record-website-provenance.mjs [hours] [entity] [--hours n] [--entity pizza|taco] [--ids id,id] [--dry-run]');
      process.exit(0);
    }
    if (arg === '--dry-run') { options.dryRun = true; continue; }
    if (arg === '--hours' || arg === '--entity' || arg === '--ids') {
      if (seen.has(arg) || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`${arg} requires one value`);
      seen.add(arg);
      const value = argv[++index];
      if (arg === '--hours') options.hours = Number(value);
      else if (arg === '--entity') options.entity = String(value).toLowerCase();
      else options.ids = value.split(',').map(item => Number(item.trim()));
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
    if (index === 0 && /^\d+(?:\.\d+)?$/.test(arg)) options.hours = Number(arg);
    else if ((index === 0 || index === 1) && ['pizza', 'taco'].includes(arg.toLowerCase())) options.entity = arg.toLowerCase();
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!Number.isFinite(options.hours) || options.hours < 0 || options.hours > 8760) throw new Error('Hours must be between 0 and 8760');
  if (!['pizza', 'taco'].includes(options.entity)) throw new Error('Entity must be pizza or taco');
  if (options.ids.length > 100 || options.ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('IDs must be 1-100 distinct positive integers');
  if (new Set(options.ids).size !== options.ids.length) throw new Error('IDs must be distinct');
  return options;
}

const env = loadRuntimeEnvironment();
const options = parseArgs(process.argv.slice(2), env);
const table = options.entity === 'taco' ? 'taco_places' : 'pizza_places';
const predicates = ["scrape_method IN ('fetch', 'browser')", 'website_url IS NOT NULL', "COALESCE(last_enriched_at, updated_at, NOW()) >= NOW() - ($1::text || ' hours')::interval"];
const params = [String(options.hours), ...(!options.dryRun ? [options.entity] : [])];
if (options.ids.length) {
  predicates.push(`id = ANY($${params.length + 1}::bigint[])`);
  params.push(options.ids);
}
const client = new pg.Client({
  host: env.PGHOST || env.LOCAL_DB_HOST || 'localhost',
  port: Number(env.PGPORT || env.LOCAL_DB_PORT || 5432),
  database: env.PGDATABASE || env.LOCAL_DB_NAME || 'pizza_enrichment',
  user: env.PGUSER || env.LOCAL_DB_USER || env.USER || process.env.USER,
  password: env.PGPASSWORD || env.LOCAL_DB_PASSWORD || '',
  connectionTimeoutMillis: 15000,
  statement_timeout: 30000,
  query_timeout: 30000,
});
try {
  await client.connect();
  const result = await client.query(options.dryRun ? `
  SELECT id
  FROM ${table}
  WHERE ${predicates.join(' AND ')}
  ORDER BY id
` : `
  INSERT INTO place_sources (entity_type, place_id, source, source_id, source_url, license, attribution, data, match_confidence, match_method, retrieved_at, updated_at)
  SELECT $2, id, 'official_website', CONCAT('place:', id), website_url, 'first-party-factual-evidence', 'official restaurant website',
         jsonb_build_object('website', website_url, 'phone', phone, 'menu_url', menu_url, 'email', email, 'hours', hours,
                            'delivery', delivery, 'takeaway', takeaway, 'scrape_method', scrape_method),
         1.0, 'scraped_first_party', COALESCE(last_enriched_at, NOW()), NOW()
  FROM ${table}
  WHERE ${predicates.join(' AND ')}
  ON CONFLICT (entity_type, source, source_id) DO UPDATE SET
    place_id = EXCLUDED.place_id,
    source_url = EXCLUDED.source_url,
    data = EXCLUDED.data,
    retrieved_at = EXCLUDED.retrieved_at,
    updated_at = NOW()
  RETURNING id
`, params);
  console.log(options.dryRun
  ? `official_website provenance rows eligible: ${result.rowCount}`
  : `official_website provenance rows upserted: ${result.rowCount}`);
} finally {
  await client.end();
}
