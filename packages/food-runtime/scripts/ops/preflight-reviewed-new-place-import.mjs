#!/usr/bin/env node
/**
 * Preflight/import tool for accepted likely-new source review rows.
 *
 * Default mode is read-only. With --apply, this imports candidate_ready rows
 * into the local canonical table, records source evidence, and links the
 * source_review_queue row. It never writes Supabase.
 */

import pg from 'pg';
import { mkdirSync, writeFileSync } from 'fs';
import { basename, resolve } from 'path';
import { loadRuntimeEnvironment } from '../lib/runtime-environment.mjs';

const ENTITY_TABLES = {
  pizza: 'pizza_places',
  taco: 'taco_places',
};

const ATP_REPORT_CANONICAL_NAMES = {
  'and_pizza-review.json': '&pizza',
  'bc_pizza-review.json': 'B.C. Pizza',
  'california_pizza_kitchen-review.json': 'California Pizza Kitchen',
  'dominos_pizza_us-review.json': "Domino's Pizza",
  'flippin_pizza_us-review.json': "Flippin' Pizza",
  'foxs_pizza-review.json': "Fox's Pizza",
  'grimaldis_pizzeria-review.json': "Grimaldi's Pizzeria",
  'larosas-review.json': "LaRosa's Pizzeria",
  'little_caesars_us-review.json': 'Little Caesars',
  'marcos-review.json': "Marco's Pizza",
  'mod_pizza-review.json': 'MOD Pizza',
  'monicals_pizza_us-review.json': "Monical's Pizza",
  'mountain_mikes_us-review.json': "Mountain Mike's Pizza",
  'papa_johns-review.json': "Papa John's",
  'papa_murphys-review.json': "Papa Murphy's",
  'pizza_ranch_us-review.json': 'Pizza Ranch',
  'round_table_pizza-review.json': 'Round Table Pizza',
  'sals_pizza_us-review.json': "Sal's Pizza",
  'simple_simons_pizza_us-review.json': "Simple Simon's Pizza",
  'vocelli_pizza_us-review.json': 'Vocelli Pizza',
};

function parseArgs(argv) {
  const args = {
    entity: 'pizza',
    source: null,
    reportFile: null,
    state: null,
    reviewIds: [],
    limit: 100,
    readyLimit: null,
    nearbyRadiusM: 150,
    output: null,
    apply: false,
    json: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--entity') args.entity = argv[++i];
    else if (arg === '--source') args.source = argv[++i];
    else if (arg === '--report-file') args.reportFile = argv[++i];
    else if (arg === '--state') args.state = argv[++i];
    else if (arg === '--ids') args.reviewIds = parseIdList(argv[++i]);
    else if (arg === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (arg === '--ready-limit') args.readyLimit = parseInt(argv[++i], 10);
    else if (arg === '--nearby-radius-m') args.nearbyRadiusM = parseFloat(argv[++i]);
    else if (arg === '--output') args.output = argv[++i];
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!ENTITY_TABLES[args.entity]) throw new Error('Invalid --entity. Use pizza or taco.');
  if (args.reviewIds.length > 100) throw new Error('Invalid --ids. Use at most 100 exact review ids.');
  if (args.reviewIds.length) args.limit = Math.max(args.limit, args.reviewIds.length);
  if (!Number.isFinite(args.limit) || args.limit <= 0) throw new Error('Invalid --limit');
  if (args.readyLimit !== null && (!Number.isFinite(args.readyLimit) || args.readyLimit <= 0)) {
    throw new Error('Invalid --ready-limit');
  }
  if (!Number.isFinite(args.nearbyRadiusM) || args.nearbyRadiusM <= 0) throw new Error('Invalid --nearby-radius-m');
  // Queue rows persist the report basename. Accept both the basename emitted
  // by operator handoffs and a repository-relative/absolute report path.
  if (args.reportFile) args.reportFile = basename(args.reportFile);
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/ops/preflight-reviewed-new-place-import.mjs [options]

Options:
  --entity <pizza|taco>       Entity type (default pizza)
  --source <key>              Optional source filter
  --report-file <file>        Optional review report filter
  --state <code>              Optional source state/region/country filter
  --ids <ids>                 Optional exact source_review_queue ids
  --limit <n>                 Accepted row scan limit (default 100)
  --ready-limit <n>           Maximum ready or replacement-ready rows to import
  --nearby-radius-m <n>       Duplicate warning radius in meters (default 150)
  --output <file>             Optional CSV output path
  --apply                     Import candidate_ready rows into local Postgres
  --json                      Emit JSON instead of Markdown

Default mode is read-only. With --apply, only candidate_ready or replacement-ready rows are imported.
Rows with missing fields, duplicate source ids, or nearby canonical places stay
in the accepted review queue for additional review.
`);
}

function parseIdList(value) {
  return [...new Set(String(value || '')
    .split(',')
    .map(item => Number.parseInt(item.trim(), 10))
    .filter(Number.isFinite)
    .filter(id => id > 0))];
}

function dbConfig() {
  const env = loadRuntimeEnvironment();

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

function csvCell(value) {
  const text = value == null ? '' : String(value).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sourceCoordinate(row, keys) {
  for (const key of keys) {
    const value = toNumber(row.source_data?.[key]);
    if (value !== null) return value;
  }
  return null;
}

function sourceAddress(row) {
  return row.source_data?.address || row.source_data?.['addr:full'] || null;
}

function canonicalSourceName(row) {
  if (row.source === 'all_the_places' && row.report_file === 'pizza_hut_us-review.json') {
    return /express/i.test(row.source_name || row.source_data?.name || '')
      ? 'Pizza Hut Express'
      : 'Pizza Hut';
  }
  if (row.source === 'all_the_places' && row.report_file === 'mr_gattis_pizza_us-review.json') {
    const rawName = row.source_name || row.source_data?.name || '';
    if (/gattitown/i.test(rawName)) return 'GattiTown';
    if (/gattiland/i.test(rawName)) return 'GattiLand';
    return "Mr Gatti's Pizza";
  }
  if (row.source === 'all_the_places' && ATP_REPORT_CANONICAL_NAMES[row.report_file]) {
    return ATP_REPORT_CANONICAL_NAMES[row.report_file];
  }
  return row.source_name || row.source_data?.name || null;
}

function candidatePayload(row) {
  const lat = sourceCoordinate(row, ['lat', 'latitude']);
  const lng = sourceCoordinate(row, ['lng', 'lon', 'longitude']);
  const sourceKey = String(row.source || '').trim();
  const sourceId = String(row.source_id || '').trim();
  // OSM exports already namespace their IDs (for example osm:way/123).
  // Avoid producing the invalid osm:osm:way/123 canonical identity.
  const normalizedSourceId = sourceKey === 'osm' ? sourceId.replace(/^osm:/, '') : sourceId;
  return {
    name: canonicalSourceName(row),
    lat,
    lng,
    address: sourceAddress(row),
    google_place_id: sourceKey && normalizedSourceId ? `${sourceKey}:${normalizedSourceId}` : null,
    state: row.source_data?.region || row.source_data?.state || row.source_data?.country || null,
    status: 'unvisited',
    address_source: row.source === 'osm' ? 'osm' : null,
    website_url: row.source_data?.website || row.source_data?.['contact:website'] || null,
    phone: row.source_data?.phone || row.source_data?.['contact:phone'] || null,
    enrichment_status: 'pending',
  };
}

function sourceMetadata(source) {
  const registry = {
    all_the_places: {
      license: 'CC0-1.0',
      attribution: 'All the Places contributors',
    },
    fsq_os_places: {
      license: 'Apache-2.0',
      attribution: 'Copyright Foursquare Labs, Inc.',
    },
    osm: {
      license: 'ODbL-1.0',
      attribution: 'OpenStreetMap contributors',
    },
    overture_places: {
      license: 'see-release-and-record-sources',
      attribution: 'Overture Maps Foundation, overturemaps.org',
    },
    wikidata: {
      license: 'CC0-1.0',
      attribution: 'Wikidata contributors',
    },
    government_open_data: {
      license: 'dataset-specific',
      attribution: 'dataset-specific',
    },
    denue: {
      license: 'verify-before-import',
      attribution: 'INEGI DENUE',
    },
    official_website: {
      license: 'first-party-factual-evidence',
      attribution: 'official restaurant website',
    },
  };
  return registry[source] || { license: 'source-specific', attribution: source };
}

async function sourceReviewQueueExists(client) {
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

async function placeSourcesExists(client) {
  const result = await client.query(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'place_sources'
    ) AS exists
  `);
  return Boolean(result.rows[0]?.exists);
}

async function fetchReviewRows(client, args) {
  const filters = [
    `entity_type = $1`,
    `review_kind = 'likely_new'`,
    `status = 'accepted'`,
  ];
  const values = [args.entity];

  if (args.source) {
    values.push(args.source);
    filters.push(`source = $${values.length}`);
  }
  if (args.reportFile) {
    values.push(args.reportFile);
    filters.push(`report_file = $${values.length}`);
  }
  if (args.state) {
    values.push(String(args.state).trim().toUpperCase());
    filters.push(`UPPER(COALESCE(source_data->>'region', source_data->>'state', source_data->>'country', '')) = $${values.length}`);
  }
  if (args.reviewIds.length) {
    values.push(args.reviewIds);
    filters.push(`id = ANY($${values.length}::bigint[])`);
  }

  values.push(args.limit);
  const result = await client.query(`
    SELECT
      id,
      entity_type,
      source,
      source_id,
      source_name,
      source_url,
      source_data,
      reviewer_notes,
      reviewed_at,
      reviewed_by,
      report_file
    FROM source_review_queue
    WHERE ${filters.join(' AND ')}
    ORDER BY reviewed_at NULLS LAST, source_name NULLS LAST, id
    LIMIT $${values.length}
  `, values);

  return result.rows;
}

async function fetchLikelyNewStatusCounts(client, args) {
  const filters = [
    `entity_type = $1`,
    `review_kind = 'likely_new'`,
  ];
  const values = [args.entity];

  if (args.source) {
    values.push(args.source);
    filters.push(`source = $${values.length}`);
  }
  if (args.reportFile) {
    values.push(args.reportFile);
    filters.push(`report_file = $${values.length}`);
  }
  if (args.state) {
    values.push(String(args.state).trim().toUpperCase());
    filters.push(`UPPER(COALESCE(source_data->>'region', source_data->>'state', source_data->>'country', '')) = $${values.length}`);
  }
  if (args.reviewIds.length) {
    values.push(args.reviewIds);
    filters.push(`id = ANY($${values.length}::bigint[])`);
  }

  const result = await client.query(`
    SELECT status, COUNT(*)::int AS count
    FROM source_review_queue
    WHERE ${filters.join(' AND ')}
    GROUP BY status
    ORDER BY status
  `, values);

  return result.rows;
}

async function findNearby(client, tableName, payload, radiusM) {
  if (payload.lat === null || payload.lng === null) return [];
  const result = await client.query(`
    SELECT
      id,
      name,
      state,
      google_place_id,
      ROUND((
        6371000 * 2 * ASIN(SQRT(
          POWER(SIN(RADIANS(($1 - lat) / 2)), 2) +
          COS(RADIANS(lat)) * COS(RADIANS($1)) *
          POWER(SIN(RADIANS(($2 - lng) / 2)), 2)
        ))
      )::numeric, 2) AS distance_m
    FROM ${tableName}
    WHERE lat BETWEEN $1 - ($3 / 111320.0) AND $1 + ($3 / 111320.0)
      AND lng BETWEEN $2 - ($3 / (111320.0 * GREATEST(COS(RADIANS($1)), 0.01)))
                  AND $2 + ($3 / (111320.0 * GREATEST(COS(RADIANS($1)), 0.01)))
      AND (
        6371000 * 2 * ASIN(SQRT(
          POWER(SIN(RADIANS(($1 - lat) / 2)), 2) +
          COS(RADIANS(lat)) * COS(RADIANS($1)) *
          POWER(SIN(RADIANS(($2 - lng) / 2)), 2)
        ))
      ) <= $3
    ORDER BY distance_m ASC
    LIMIT 3
  `, [payload.lat, payload.lng, radiusM]);
  return result.rows;
}

async function loadCanonicalPlaces(client, tableName, payloads, radiusM) {
  const located = payloads.filter(payload => payload.lat !== null && payload.lng !== null);
  if (!located.length) return [];

  const lats = located.map(payload => payload.lat);
  const lngs = located.map(payload => payload.lng);
  const latPad = radiusM / 111320;
  const minLat = Math.min(...lats) - latPad;
  const maxLat = Math.max(...lats) + latPad;
  const minLngRaw = Math.min(...lngs);
  const maxLngRaw = Math.max(...lngs);
  const lngPad = radiusM / (111320 * Math.max(Math.cos(((minLat + maxLat) / 2) * Math.PI / 180), 0.01));
  const minLng = minLngRaw - lngPad;
  const maxLng = maxLngRaw + lngPad;

  const result = await client.query(`
    SELECT
      id,
      name,
      state,
      google_place_id,
      lat::double precision AS lat,
      lng::double precision AS lng
    FROM ${tableName}
    WHERE lat IS NOT NULL
      AND lng IS NOT NULL
      AND lat::double precision BETWEEN $1 AND $2
      AND lng::double precision BETWEEN $3 AND $4
      AND COALESCE(lifecycle_status, '') NOT IN ('closed', 'replaced', 'demolished')
  `, [minLat, maxLat, minLng, maxLng]);

  return result.rows;
}

function cellKey(lat, lng, cellDegrees) {
  return `${Math.floor(lat / cellDegrees)}:${Math.floor(lng / cellDegrees)}`;
}

function buildPlaceGrid(places, cellDegrees) {
  const grid = new Map();
  for (const place of places) {
    const key = cellKey(place.lat, place.lng, cellDegrees);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(place);
  }
  return grid;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = value => value * Math.PI / 180;
  const earthRadiusM = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadiusM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function nearbyPlacesFromGrid(grid, payload, { radiusM, cellDegrees }) {
  if (payload.lat === null || payload.lng === null) return [];

  const latCell = Math.floor(payload.lat / cellDegrees);
  const lngCell = Math.floor(payload.lng / cellDegrees);
  const cellRadius = Math.max(1, Math.ceil((radiusM / 111320) / cellDegrees) + 1);
  const rows = [];

  for (let latOffset = -cellRadius; latOffset <= cellRadius; latOffset++) {
    for (let lngOffset = -cellRadius; lngOffset <= cellRadius; lngOffset++) {
      const places = grid.get(`${latCell + latOffset}:${lngCell + lngOffset}`) || [];
      for (const place of places) {
        const distanceM = haversineMeters(payload.lat, payload.lng, place.lat, place.lng);
        if (distanceM <= radiusM) {
          rows.push({
            ...place,
            distance_m: Number(distanceM.toFixed(2)),
          });
        }
      }
    }
  }

  return rows
    .sort((a, b) => a.distance_m - b.distance_m)
    .slice(0, 3);
}

async function googlePlaceIdExists(client, tableName, googlePlaceId) {
  if (!googlePlaceId) return false;
  const result = await client.query(`SELECT id FROM ${tableName} WHERE google_place_id = $1 LIMIT 1`, [googlePlaceId]);
  return Boolean(result.rows[0]);
}

async function existingGooglePlaceIds(client, tableName, payloads) {
  const ids = [...new Set(payloads.map(payload => payload.google_place_id).filter(Boolean))];
  if (!ids.length) return new Map();
  const result = await client.query(
    `SELECT google_place_id, lifecycle_status FROM ${tableName} WHERE google_place_id = ANY($1::text[])`,
    [ids],
  );
  return new Map(result.rows.map(row => [row.google_place_id, row]));
}

async function existingExternalIdentities(client, entity, rows, payloads) {
  const legacyIds = await existingGooglePlaceIds(client, ENTITY_TABLES[entity], payloads);
  const result = new Set([...legacyIds.keys()].map(id => `legacy:${id}`));
  const tableExists = (await client.query(`SELECT to_regclass('public.place_external_ids') IS NOT NULL AS exists`)).rows[0].exists;
  if (!tableExists) return { identities: result, legacyPlaces: legacyIds };

  const pairs = rows.map((row, index) => {
    const source = String(row.source || '').trim();
    const sourceId = source === 'osm'
      ? String(row.source_id || '').trim().replace(/^osm:/, '')
      : String(row.source_id || '').trim();
    return source && sourceId && payloads[index]?.google_place_id ? { source, sourceId } : null;
  }).filter(Boolean);
  if (!pairs.length) return { identities: result, legacyPlaces: legacyIds };
  const values = [entity];
  const clauses = pairs.map(pair => {
    values.push(pair.source, pair.sourceId);
    return `(source = $${values.length - 1} AND external_id = $${values.length})`;
  });
  const external = await client.query(
    `SELECT source, external_id FROM place_external_ids WHERE entity_type = $1 AND (${clauses.join(' OR ')})`,
    values,
  );
  for (const row of external.rows) result.add(`${row.source}:${row.external_id}`);
  return { identities: result, legacyPlaces: legacyIds };
}

function legacyPlaceForPayload(legacyPlaces, payload) {
  return payload.google_place_id ? legacyPlaces.get(payload.google_place_id) || null : null;
}

async function allocateNextCanonicalPlaceId(client, tableName) {
  await client.query(`LOCK TABLE ${tableName} IN EXCLUSIVE MODE`);
  const result = await client.query(`SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM ${tableName}`);
  return result.rows[0]?.next_id;
}

function readiness(payload, duplicateBySourceId, nearbyRows) {
  const missing = [];
  if (!payload.name) missing.push('name');
  if (payload.lat === null) missing.push('lat');
  if (payload.lng === null) missing.push('lng');
  if (!payload.google_place_id) missing.push('source_id');
  if (missing.length) return `missing_${missing.join('_')}`;
  if (duplicateBySourceId && !['closed', 'replaced', 'demolished'].includes(duplicateBySourceId.lifecycle_status)) return 'duplicate_source_id';
  if (duplicateBySourceId) return 'replacement_candidate_ready';
  if (nearbyRows.length) return 'nearby_canonical_review';
  return 'candidate_ready';
}

function sourceCandidateDistanceMeters(a, b) {
  if (a.proposed_lat === null || a.proposed_lng === null || b.proposed_lat === null || b.proposed_lng === null) return null;
  const toRad = value => Number(value) * Math.PI / 180;
  const lat1 = toRad(a.proposed_lat);
  const lat2 = toRad(b.proposed_lat);
  const deltaLat = toRad(Number(b.proposed_lat) - Number(a.proposed_lat));
  const deltaLng = toRad(Number(b.proposed_lng) - Number(a.proposed_lng));
  const haversine = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function annotateAcceptedSourceCoordinateDuplicates(candidates, duplicateRadiusM = 25) {
  for (const candidate of candidates) {
    if (candidate.readiness !== 'candidate_ready') continue;
    const duplicates = candidates
      .filter(other => other !== candidate && other.source_id !== candidate.source_id)
      .map(other => ({
        candidate: other,
        distanceM: sourceCandidateDistanceMeters(candidate, other),
      }))
      .filter(item => item.distanceM !== null && item.distanceM <= duplicateRadiusM)
      .sort((a, b) => a.distanceM - b.distanceM);

    const nearest = duplicates[0];
    if (!nearest) continue;
    candidate.readiness = 'duplicate_accepted_source_coordinate';
    candidate.nearest_source_review_id = nearest.candidate.review_id;
    candidate.nearest_source_name = nearest.candidate.source_name;
    candidate.nearest_source_distance_m = Number(nearest.distanceM.toFixed(2));
  }
}

function statusCount(rows, status) {
  return Number(rows.find(row => row.status === status)?.count) || 0;
}

function nextAction(likelyNewStatusCounts, rowsInspected) {
  const accepted = statusCount(likelyNewStatusCounts, 'accepted');
  const pending = statusCount(likelyNewStatusCounts, 'pending');

  if (accepted > 0 && rowsInspected > 0) return 'review_preflight_readiness';
  if (accepted > 0) return 'increase_limit_or_check_source_filter';
  if (pending > 0) return 'accept_likely_new_candidates_in_admin';
  return 'no_likely_new_candidates';
}

async function buildReport(client, args) {
  const tableName = ENTITY_TABLES[args.entity];
  const likelyNewStatusCounts = await fetchLikelyNewStatusCounts(client, args);
  const rows = await fetchReviewRows(client, args);
  const candidates = [];
  const payloads = rows.map(row => candidatePayload(row));
  const externalIdentityState = await existingExternalIdentities(client, args.entity, rows, payloads);
  const duplicateExternalIdentities = externalIdentityState.identities;
  const existingLegacyPlaces = externalIdentityState.legacyPlaces;
  const canonicalPlaces = await loadCanonicalPlaces(client, tableName, payloads, args.nearbyRadiusM);
  const gridCellDegrees = 0.02;
  const placeGrid = buildPlaceGrid(canonicalPlaces, gridCellDegrees);

  rows.forEach((row, index) => {
    const payload = payloads[index];
    const sourceId = String(row.source_id || '').trim().replace(/^osm:/, '');
    const duplicateBySourceId = duplicateExternalIdentities.has(`${row.source}:${sourceId}`)
      ? { lifecycle_status: null }
      : legacyPlaceForPayload(existingLegacyPlaces, payload);
    const nearbyRows = nearbyPlacesFromGrid(placeGrid, payload, {
      radiusM: args.nearbyRadiusM,
      cellDegrees: gridCellDegrees,
    });
    candidates.push({
      row,
      review_id: row.id,
      entity_type: row.entity_type,
      source: row.source,
      source_id: row.source_id,
      source_name: row.source_name,
      proposed_google_place_id: payload.google_place_id,
      proposed_name: payload.name,
      proposed_lat: payload.lat,
      proposed_lng: payload.lng,
      proposed_address: payload.address,
      proposed_state: payload.state,
      proposed_website_url: payload.website_url,
      proposed_phone: payload.phone,
      readiness: readiness(payload, duplicateBySourceId, nearbyRows),
      nearby_count: nearbyRows.length,
      nearest_place_id: nearbyRows[0]?.id || null,
      nearest_place_name: nearbyRows[0]?.name || null,
      nearest_distance_m: nearbyRows[0]?.distance_m || null,
      nearest_source_review_id: null,
      nearest_source_name: null,
      nearest_source_distance_m: null,
      reviewed_at: row.reviewed_at,
      report_file: row.report_file,
    });
  });

  annotateAcceptedSourceCoordinateDuplicates(candidates);

  const readinessCounts = candidates.reduce((acc, row) => {
    acc[row.readiness] = (acc[row.readiness] || 0) + 1;
    return acc;
  }, {});

  return {
    generatedAt: new Date().toISOString(),
    entity: args.entity,
    source: args.source || 'all',
    report_file: args.reportFile || 'all',
    state: args.state || 'all',
    review_ids: args.reviewIds,
    tableName,
    nearbyRadiusM: args.nearbyRadiusM,
    readyLimit: args.readyLimit,
    likelyNewStatusCounts,
    nextAction: nextAction(likelyNewStatusCounts, rows.length),
    rowsInspected: rows.length,
    canonicalRowsPrefetched: canonicalPlaces.length,
    coordinateGridCellsBuilt: placeGrid.size,
    readinessCounts,
    candidates,
  };
}

function sourceRecordData(candidate, placeId) {
  const sourceId = candidate.source === 'osm'
    ? String(candidate.source_id || '').replace(/^osm:/, '')
    : candidate.source_id;
  return {
    ...(candidate.row.source_data || {}),
    source_id: sourceId,
    name: candidate.source_name,
    source_url: candidate.row.source_url || null,
    imported_place: {
      id: placeId,
      google_place_id: candidate.proposed_google_place_id,
      name: candidate.proposed_name,
    },
    review: {
      queue_id: candidate.review_id,
      review_kind: 'likely_new',
      decision: 'imported_new',
      reviewed_by: candidate.row.reviewed_by || 'admin',
      reviewer_notes: candidate.row.reviewer_notes || null,
      report_file: candidate.report_file || null,
    },
  };
}

async function importCandidate(client, tableName, candidate) {
  const metadata = sourceMetadata(candidate.source);
  const payload = candidatePayload(candidate.row);
  const sourceId = candidate.source === 'osm'
    ? String(candidate.source_id || '').replace(/^osm:/, '')
    : candidate.source_id;
  const placeId = await allocateNextCanonicalPlaceId(client, tableName);
  const existing = payload.google_place_id
    ? (await client.query(`
        SELECT id, google_place_id, lifecycle_status
        FROM ${tableName}
        WHERE google_place_id = $1
        FOR UPDATE
      `, [payload.google_place_id])).rows[0] || null
    : null;
  if (existing && !['closed', 'replaced', 'demolished'].includes(existing.lifecycle_status)) {
    throw new Error('This source identity already belongs to an active place.');
  }
  if (existing) {
    await client.query(`
      UPDATE ${tableName}
      SET google_place_id = $2, updated_at = NOW()
      WHERE id = $1
    `, [existing.id, `historical:${payload.google_place_id}`]);
  }

  const insert = await client.query(`
    INSERT INTO ${tableName} (
      id,
      name,
      lat,
      lng,
      address,
      google_place_id,
      state,
      status,
      website_url,
      phone,
      address_source,
      enrichment_status
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    RETURNING id
  `, [
    placeId,
    payload.name,
    payload.lat,
    payload.lng,
    payload.address,
    payload.google_place_id,
    payload.state,
    payload.status,
    payload.website_url,
    payload.phone,
    payload.address_source,
    payload.enrichment_status,
  ]);

  const insertedPlaceId = insert.rows[0].id;

  if (existing) {
    await client.query(`
      UPDATE ${tableName}
      SET lifecycle_status = 'replaced', lifecycle_replaced_by_id = $2, updated_at = NOW()
      WHERE id = $1
    `, [existing.id, insertedPlaceId]);
  }

  await client.query(`
    INSERT INTO place_sources (
      entity_type,
      place_id,
      source,
      source_id,
      source_url,
      license,
      attribution,
      data,
      match_confidence,
      match_method,
      retrieved_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, NOW())
    ON CONFLICT (entity_type, source, source_id) DO UPDATE SET
      place_id = EXCLUDED.place_id,
      source_url = EXCLUDED.source_url,
      license = EXCLUDED.license,
      attribution = EXCLUDED.attribution,
      data = EXCLUDED.data,
      match_confidence = EXCLUDED.match_confidence,
      match_method = EXCLUDED.match_method,
      retrieved_at = EXCLUDED.retrieved_at,
      updated_at = NOW()
  `, [
    candidate.entity_type,
    insertedPlaceId,
    candidate.source,
    sourceId,
    candidate.row.source_url || null,
    metadata.license,
    metadata.attribution,
    JSON.stringify(sourceRecordData(candidate, insertedPlaceId)),
    1,
    'reviewed_new_import',
  ]);

  await client.query(`
    UPDATE source_review_queue
    SET
      status = 'linked',
      decision = 'imported_new',
      canonical_place_id = $2,
      updated_at = NOW()
    WHERE id = $1
  `, [candidate.review_id, insertedPlaceId]);

  return insertedPlaceId;
}

async function applyReadyCandidates(client, report) {
  if (!(await placeSourcesExists(client))) {
    throw new Error('place_sources table does not exist. Run backfill-place-sources.mjs --apply-schema first.');
  }

  const ready = report.candidates.filter(candidate => ['candidate_ready', 'replacement_candidate_ready'].includes(candidate.readiness));
  const selected = report.readyLimit ? ready.slice(0, report.readyLimit) : ready;
  const skipped = report.candidates.length - selected.length;
  const imported = [];

  for (const candidate of selected) {
    await client.query('BEGIN');
    try {
      const placeId = await importCandidate(client, report.tableName, candidate);
      await client.query('COMMIT');
      imported.push({ review_id: candidate.review_id, place_id: placeId, source_name: candidate.source_name });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }

  return { ready: selected.length, readyAvailable: ready.length, imported, skipped };
}

function writeCsv(report, output) {
  const headers = [
    'review_id',
    'entity_type',
    'source',
    'source_id',
    'source_name',
    'proposed_google_place_id',
    'proposed_name',
    'proposed_lat',
    'proposed_lng',
    'proposed_address',
    'proposed_state',
    'proposed_website_url',
    'proposed_phone',
    'readiness',
    'nearby_count',
    'nearest_place_id',
    'nearest_place_name',
    'nearest_distance_m',
    'nearest_source_review_id',
    'nearest_source_name',
    'nearest_source_distance_m',
    'reviewed_at',
    'report_file',
  ];
  const csv = [
    headers.join(','),
    ...report.candidates.map(row => headers.map(header => csvCell(row[header])).join(',')),
  ].join('\n');
  const outputPath = resolve(process.cwd(), output);
  mkdirSync(resolve(outputPath, '..'), { recursive: true });
  writeFileSync(outputPath, `${csv}\n`);
}

async function main() {
  const args = parseArgs(process.argv);
  const client = new pg.Client(dbConfig());
  await client.connect();

  try {
    if (!(await sourceReviewQueueExists(client))) {
      throw new Error('source_review_queue table does not exist.');
    }

    const report = await buildReport(client, args);
    const readyAvailable = report.candidates.filter(candidate => ['candidate_ready', 'replacement_candidate_ready'].includes(candidate.readiness)).length;
    const applyResult = args.apply
      ? await applyReadyCandidates(client, report)
      : { ready: 0, readyAvailable, imported: [], skipped: report.candidates.length };
    if (args.output) writeCsv(report, args.output);

    if (args.json) {
      console.log(JSON.stringify({ ...report, mode: args.apply ? 'apply' : 'dry-run', applyResult }, null, 2));
      return;
    }

    console.log('# Reviewed New Place Import Preflight');
    console.log('');
    console.log(`Generated: ${report.generatedAt}`);
    console.log(`Entity: ${report.entity}`);
    console.log(`Source: ${report.source}`);
    console.log(`Report file: ${report.report_file}`);
    console.log(`State: ${report.state}`);
    console.log(`Review ids: ${report.review_ids.length ? report.review_ids.join(',') : 'all'}`);
    console.log(`Canonical table: ${report.tableName}`);
    console.log(`Mode: ${args.apply ? 'apply' : 'dry-run'}`);
    console.log(`Nearby duplicate radius: ${report.nearbyRadiusM}m`);
    console.log(`Ready import limit: ${report.readyLimit || 'all candidate_ready rows'}`);
    console.log(`Accepted likely-new rows inspected: ${report.rowsInspected}`);
    console.log(`Next action: ${report.nextAction}`);
    if (args.output) console.log(`CSV output: ${args.output}`);
    console.log('');
    console.log('## Likely-New Queue Status');
    console.log(table(['status', 'count'], report.likelyNewStatusCounts));
    console.log('');
    console.log('## Readiness Counts');
    console.log(table(
      ['readiness', 'count'],
      Object.entries(report.readinessCounts).map(([readiness, count]) => ({ readiness, count }))
    ));
    console.log('');
    console.log('## Candidate Samples');
    console.log(table(
      ['review_id', 'source', 'source_name', 'proposed_lat', 'proposed_lng', 'readiness', 'nearest_place_name', 'nearest_distance_m', 'nearest_source_name', 'nearest_source_distance_m'],
      report.candidates.slice(0, 25)
    ));
    console.log('');
    if (args.apply) {
      console.log('## Apply Result');
      console.log(table(
        ['metric', 'count'],
        [
          { metric: 'candidate_ready rows selected', count: applyResult.ready },
          { metric: 'candidate_ready rows available', count: applyResult.readyAvailable },
          { metric: 'canonical places imported', count: applyResult.imported.length },
          { metric: 'rows skipped for further review', count: applyResult.skipped },
        ]
      ));
      console.log('');
      console.log('## Imported Rows');
      console.log(table(['review_id', 'place_id', 'source_name'], applyResult.imported.slice(0, 25)));
      console.log('');
      console.log('Wrote local canonical places, place_sources rows, and source_review_queue links only. No Supabase records were written.');
    } else {
      console.log('No canonical places, place_sources rows, source_review_queue rows, or Supabase records were written.');
    }
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error(`preflight-reviewed-new-place-import failed: ${error.message || error}`);
  process.exit(1);
});
