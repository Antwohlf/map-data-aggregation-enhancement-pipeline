#!/usr/bin/env node

import pg from 'pg';
import { writeFileSync } from 'node:fs';
import { loadRuntimeEnvironment } from '../lib/runtime-environment.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((out, value, index, values) => {
  if (value.startsWith('--')) out.push([value.slice(2), values[index + 1]]);
  return out;
}, []));
const output = args.output;
// Keep requests below the Wikidata API's practical URL/response ceiling. A
// larger candidate query can return an empty entity map without an HTTP error.
const limit = Math.min(Number(args.limit || 25), 25);
const states = String(args.states || '').split(',').map(value => value.trim().toUpperCase()).filter(Boolean);
if (!output) throw new Error('Usage: export-wikidata-source.mjs --output file [--limit n<=25]');

const env = loadRuntimeEnvironment();
const client = new pg.Client({
  host: env.PGHOST || env.LOCAL_DB_HOST || 'localhost',
  port: Number(env.PGPORT || env.LOCAL_DB_PORT || 5432),
  database: env.PGDATABASE || env.LOCAL_DB_NAME || 'pizza_enrichment',
  user: env.PGUSER || env.LOCAL_DB_USER || process.env.USER,
  password: env.PGPASSWORD || env.LOCAL_DB_PASSWORD || '',
  connectionTimeoutMillis: 15000,
  statement_timeout: 30000,
});
await client.connect();
const { rows: places } = await client.query(`
    SELECT DISTINCT ON (qid) qid, id, name, state, lat, lng
    FROM (
    SELECT id, name, state, lat, lng, NULLIF(btrim(COALESCE(brand_wikidata, '')), '') qid FROM pizza_places
    UNION ALL
    SELECT id, name, state, lat, lng, NULLIF(btrim(COALESCE(operator_wikidata, '')), '') qid FROM pizza_places
    ) candidates
    WHERE btrim(qid) ~ '^Q[0-9]+$'
      ${states.length ? 'AND UPPER(state) = ANY($2::text[])' : ''}
  ORDER BY qid, id
  LIMIT $1
`, states.length ? [limit, states] : [limit]);
await client.end();
if (!places.length) { writeFileSync(output, '[]\n'); console.log(JSON.stringify({ source: 'wikidata', rows: 0, candidates: 0, states: states.length ? states : 'all', output })); process.exit(0); }

const ids = places.map(row => row.qid).join('|');
const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(ids)}&props=claims|labels|sitelinks&languages=en&format=json`;
const response = await fetch(url, { headers: { 'user-agent': 'APizzaMichigan/1.0 source-pipeline' }, signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error(`Wikidata failed: ${response.status}`);
const payload = await response.json();
const byQid = new Map(places.map(row => [row.qid, row]));
const rows = Object.entries(payload.entities || {}).map(([qid, entity]) => {
  const place = byQid.get(qid);
  const claims = entity.claims || {};
  const website = claims.P856?.[0]?.mainsnak?.datavalue?.value || null;
  const label = entity.labels?.en?.value || place?.name || qid;
  return { item: qid, name: label, lat: place.lat, lng: place.lng, region: place.state, official_website: website, category: 'known pizza place', source_url: `https://www.wikidata.org/wiki/${qid}` };
});
writeFileSync(output, `${JSON.stringify(rows, null, 2)}\n`);
console.log(JSON.stringify({ source: 'wikidata', rows: rows.length, candidates: places.length, entities: Object.keys(payload.entities || {}).length, states: states.length ? states : 'all', output }));
