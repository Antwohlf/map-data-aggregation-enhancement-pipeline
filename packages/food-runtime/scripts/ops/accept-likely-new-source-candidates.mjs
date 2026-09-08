#!/usr/bin/env node
/**
 * Mark pending likely-new source review rows as accepted import candidates.
 *
 * Default mode is read-only. With --apply, this only updates
 * source_review_queue rows from pending -> accepted. It never creates canonical
 * places, writes place_sources, promotes fields, or syncs Supabase.
 */

import pg from 'pg';
import { existsSync, readFileSync } from 'fs';
import { basename, resolve } from 'path';
import { loadRuntimeEnvironment } from '../lib/runtime-environment.mjs';

const ENTITY_TABLES = {
  pizza: 'pizza_places',
  taco: 'taco_places',
};

const SIGNAL_COUNT_SQL = `(
  CASE WHEN NULLIF(source_data->>'address', '') IS NOT NULL OR NULLIF(source_data->>'addr:full', '') IS NOT NULL THEN 1 ELSE 0 END +
  CASE WHEN NULLIF(source_data->>'website', '') IS NOT NULL OR NULLIF(source_data->>'contact:website', '') IS NOT NULL THEN 1 ELSE 0 END +
  CASE WHEN NULLIF(source_data->>'phone', '') IS NOT NULL OR NULLIF(source_data->>'contact:phone', '') IS NOT NULL THEN 1 ELSE 0 END +
  CASE WHEN (
    (NULLIF(source_data->>'lat', '') IS NOT NULL OR NULLIF(source_data->>'latitude', '') IS NOT NULL) AND
    (NULLIF(source_data->>'lng', '') IS NOT NULL OR NULLIF(source_data->>'lon', '') IS NOT NULL OR NULLIF(source_data->>'longitude', '') IS NOT NULL)
  ) THEN 1 ELSE 0 END
)`;

const READINESS_SQL = `(
  CASE
    WHEN review_kind <> 'likely_new' THEN 'link_review'
    WHEN COALESCE(NULLIF(source_name, ''), NULLIF(source_data->>'name', '')) IS NULL
      OR NULLIF(source_id, '') IS NULL
      OR NOT (
        (NULLIF(source_data->>'lat', '') IS NOT NULL OR NULLIF(source_data->>'latitude', '') IS NOT NULL) AND
        (NULLIF(source_data->>'lng', '') IS NOT NULL OR NULLIF(source_data->>'lon', '') IS NOT NULL OR NULLIF(source_data->>'longitude', '') IS NOT NULL)
      )
      THEN 'missing_required_data'
    WHEN nearest_distance_m IS NOT NULL AND nearest_distance_m <= 150
      THEN 'nearby_canonical_review'
    ELSE 'candidate_ready'
  END
)`;

function parseArgs(argv) {
  const args = {
    entity: 'pizza',
    source: null,
    reportFile: null,
    state: null,
    minSignals: 3,
    limit: 100,
    scanLimit: null,
    nearbyRadiusM: 150,
    prefetchTileDegrees: 1,
    prefetchBatchSize: 100,
    allowOutOfScope: false,
    apply: false,
    json: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--entity') args.entity = argv[++i];
    else if (arg === '--source') args.source = argv[++i];
    else if (arg === '--report-file') args.reportFile = argv[++i];
    else if (arg === '--state') args.state = argv[++i];
    else if (arg === '--min-signals') args.minSignals = parseInt(argv[++i], 10);
    else if (arg === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (arg === '--scan-limit') args.scanLimit = parseInt(argv[++i], 10);
    else if (arg === '--nearby-radius-m') args.nearbyRadiusM = parseFloat(argv[++i]);
    else if (arg === '--prefetch-tile-degrees') args.prefetchTileDegrees = parseFloat(argv[++i]);
    else if (arg === '--prefetch-batch-size') args.prefetchBatchSize = parseInt(argv[++i], 10);
    else if (arg === '--allow-out-of-scope') args.allowOutOfScope = true;
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
  if (!Number.isFinite(args.minSignals) || args.minSignals < 0 || args.minSignals > 4) throw new Error('Invalid --min-signals. Use 0-4.');
  if (!Number.isFinite(args.limit) || args.limit <= 0 || args.limit > 1000) throw new Error('Invalid --limit. Use 1-1000.');
  if (args.scanLimit === null) args.scanLimit = Math.min(Math.max(args.limit * 10, args.limit), 1000);
  if (!Number.isFinite(args.scanLimit) || args.scanLimit < args.limit || args.scanLimit > 5000) {
    throw new Error('Invalid --scan-limit. Use a value from --limit through 5000.');
  }
  if (!Number.isFinite(args.nearbyRadiusM) || args.nearbyRadiusM <= 0) throw new Error('Invalid --nearby-radius-m');
  if (!Number.isFinite(args.prefetchTileDegrees) || args.prefetchTileDegrees <= 0) throw new Error('Invalid --prefetch-tile-degrees');
  if (!Number.isFinite(args.prefetchBatchSize) || args.prefetchBatchSize <= 0) throw new Error('Invalid --prefetch-batch-size');
  // Review rows persist the generated report basename, while callers often
  // pass the repository-relative path used to create that report.
  if (args.reportFile) args.reportFile = basename(args.reportFile);
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/ops/accept-likely-new-source-candidates.mjs [options]

Options:
  --entity <pizza|taco>      Entity type (default pizza)
  --source <key>             Optional source filter
  --report-file <file>       Optional review report filter
  --state <code>             Optional source state/region/country filter
  --min-signals <n>          Minimum evidence signals 0-4 (default 3)
  --limit <n>                Candidate limit, max 1000 (default 100)
  --scan-limit <n>           Pending rows to inspect before nearby filtering
                             (default min(limit * 10, 1000), max 5000)
  --nearby-radius-m <n>      Skip rows with canonical places within this radius
                             (default 150)
  --prefetch-tile-degrees <n>
                             Tile size for batched canonical prefetch
                             (default 1)
  --prefetch-batch-size <n>  Number of tiles per canonical prefetch query
                             (default 100)
  --allow-out-of-scope       Include rows outside config/source-pipeline.json
                             region keys (default is configured scope only)
  --apply                    Mark candidates accepted
  --json                     Emit JSON instead of Markdown

Default mode is read-only. Apply mode only changes pending likely-new rows to
accepted so they can be preflighted later by
preflight-reviewed-new-place-import.mjs. It never imports places or writes
Supabase. Candidate selection runs the same nearby-canonical duplicate guard
used by import preflight.
`);
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

function configuredRegions() {
  const path = resolve(process.cwd(), 'config/source-pipeline.json');
  if (!existsSync(path)) return [];
  const config = JSON.parse(readFileSync(path, 'utf8'));
  return [...new Set((config.regions || []).map(region => String(region?.key || '').trim().toUpperCase()).filter(Boolean))];
}

async function fetchCandidates(client, args) {
  const values = [args.entity, args.minSignals];
  const filters = [
    'entity_type = $1',
    "review_kind = 'likely_new'",
    "status = 'pending'",
    `${READINESS_SQL} = 'candidate_ready'`,
    `${SIGNAL_COUNT_SQL} >= $2`,
  ];

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
  if (!args.allowOutOfScope) {
    const regions = configuredRegions();
    if (!regions.length) throw new Error('Configured source scope is empty; use --allow-out-of-scope only for an intentional override.');
    values.push(regions);
    filters.push(`UPPER(COALESCE(source_data->>'region', source_data->>'state', source_data->>'country', '')) = ANY($${values.length}::text[])`);
  }

  values.push(args.limit);
  const result = await client.query(`
    SELECT
      id,
      source,
      source_id,
      source_name,
      source_data,
      source_data->>'address' AS source_address,
      source_data->>'website' AS source_website,
      source_data->>'phone' AS source_phone,
      report_file,
      nearest_distance_m,
      ${SIGNAL_COUNT_SQL}::int AS source_signal_count,
      ${READINESS_SQL} AS review_readiness
    FROM source_review_queue
    WHERE ${filters.join('\n      AND ')}
    ORDER BY
      ${SIGNAL_COUNT_SQL} DESC,
      nearest_distance_m DESC NULLS LAST,
      source_name NULLS LAST,
      id
    LIMIT $${values.length}
  `, values);
  return result.rows;
}

function buildPrefetchTiles(payloads, { radiusM, tileDegrees }) {
  const located = payloads.filter(payload => payload.lat !== null && payload.lng !== null);
  const tiles = new Map();
  for (const payload of located) {
    const latCell = Math.floor(payload.lat / tileDegrees);
    const lngCell = Math.floor(payload.lng / tileDegrees);
    const key = `${latCell}:${lngCell}`;
    const existing = tiles.get(key);
    if (existing) {
      existing.minLat = Math.min(existing.minLat, payload.lat);
      existing.maxLat = Math.max(existing.maxLat, payload.lat);
      existing.minLng = Math.min(existing.minLng, payload.lng);
      existing.maxLng = Math.max(existing.maxLng, payload.lng);
    } else {
      tiles.set(key, {
        minLat: payload.lat,
        maxLat: payload.lat,
        minLng: payload.lng,
        maxLng: payload.lng,
      });
    }
  }

  const latPad = radiusM / 111320;
  return [...tiles.values()].map(tile => {
    const centerLat = (tile.minLat + tile.maxLat) / 2;
    const lngPad = radiusM / (111320 * Math.max(Math.cos(centerLat * Math.PI / 180), 0.01));
    return {
      minLat: tile.minLat - latPad,
      maxLat: tile.maxLat + latPad,
      minLng: tile.minLng - lngPad,
      maxLng: tile.maxLng + lngPad,
    };
  });
}

function chunks(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
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

function candidatePayload(row) {
  return {
    lat: sourceCoordinate(row, ['lat', 'latitude']),
    lng: sourceCoordinate(row, ['lng', 'lon', 'longitude']),
  };
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

async function loadCanonicalPlaces(client, tableName, payloads, { radiusM, tileDegrees, batchSize }) {
  const tiles = buildPrefetchTiles(payloads, { radiusM, tileDegrees });
  if (!tiles.length) {
    return { rows: [], tileCount: 0, queryCount: 0 };
  }

  const byId = new Map();
  let queryCount = 0;
  for (const batch of chunks(tiles, batchSize)) {
    const values = [];
    const placeholders = batch.map((tile, idx) => {
      const base = idx * 4;
      values.push(tile.minLat, tile.maxLat, tile.minLng, tile.maxLng);
      return `($${base + 1}::double precision, $${base + 2}::double precision, $${base + 3}::double precision, $${base + 4}::double precision)`;
    });

    const result = await client.query(`
      WITH prefetch_boxes(min_lat, max_lat, min_lng, max_lng) AS (
        VALUES ${placeholders.join(', ')}
      )
      SELECT DISTINCT
        c.id,
        c.name,
        c.state,
        c.google_place_id,
        c.lat::double precision AS lat,
        c.lng::double precision AS lng
      FROM ${tableName} c
      JOIN prefetch_boxes b
        ON c.lat::double precision BETWEEN b.min_lat AND b.max_lat
       AND c.lng::double precision BETWEEN b.min_lng AND b.max_lng
      WHERE c.lat IS NOT NULL
        AND c.lng IS NOT NULL
    `, values);

    queryCount += 1;
    for (const row of result.rows) {
      byId.set(row.id, row);
    }
  }

  return { rows: [...byId.values()], tileCount: tiles.length, queryCount };
}

async function loadAcceptedSourceCoordinates(client, rows, args) {
  const located = rows
    .map(row => ({
      id: row.id,
      lat: sourceCoordinate(row, ['lat', 'latitude']),
      lng: sourceCoordinate(row, ['lng', 'lon', 'longitude']),
    }))
    .filter(row => row.lat !== null && row.lng !== null);
  if (!located.length) return new Map();

  const coordinateValues = [];
  const coordinateClauses = located.map(row => {
    coordinateValues.push(row.lat, row.lng);
    const latParam = 4 + coordinateValues.length - 2;
    const lngParam = 4 + coordinateValues.length - 1;
    return `(ABS(COALESCE(NULLIF(source_data->>'lat', ''), NULLIF(source_data->>'latitude', ''))::double precision - $${latParam}) < 0.00001 AND ABS(COALESCE(NULLIF(source_data->>'lng', ''), NULLIF(source_data->>'lon', ''), NULLIF(source_data->>'longitude', ''))::double precision - $${lngParam}) < 0.00001)`;
  });
  const result = await client.query(`
    SELECT id, source_data
    FROM source_review_queue
    WHERE entity_type = $1
      AND source = $2
      AND status IN ('accepted', 'linked')
      AND id <> ALL($3::bigint[])
      AND (${coordinateClauses.join(' OR ')})
  `, [args.entity, args.source, located.map(row => row.id), ...coordinateValues]);
  const duplicateIds = new Map();
  for (const row of result.rows) duplicateIds.set(String(row.id), row);
  return duplicateIds;
}

async function filterImportReadyCandidates(client, rows, args) {
  if (!rows.length) {
    return {
      candidates: [],
      scanned: 0,
      skippedNearby: 0,
      canonicalRowsPrefetched: 0,
      canonicalPrefetchTiles: 0,
      canonicalPrefetchQueries: 0,
      coordinateGridCellsBuilt: 0,
    };
  }

  const payloads = rows.map(candidatePayload);
  const canonicalPrefetch = await loadCanonicalPlaces(client, ENTITY_TABLES[args.entity], payloads, {
    radiusM: args.nearbyRadiusM,
    tileDegrees: args.prefetchTileDegrees,
    batchSize: args.prefetchBatchSize,
  });
  const canonicalPlaces = canonicalPrefetch.rows;
  const gridCellDegrees = 0.02;
  const placeGrid = buildPlaceGrid(canonicalPlaces, gridCellDegrees);
  const sourceDuplicates = args.source
    ? await loadAcceptedSourceCoordinates(client, rows, args)
    : new Map();
  const candidates = [];
  let skippedNearby = 0;
  let skippedSourceDuplicate = 0;

  rows.forEach((row, index) => {
    const payload = payloads[index];
    const nearbyRows = nearbyPlacesFromGrid(placeGrid, payload, {
      radiusM: args.nearbyRadiusM,
      cellDegrees: gridCellDegrees,
    });
    const nearest = nearbyRows[0];
    if (nearest) {
      skippedNearby += 1;
      row.review_readiness = 'nearby_canonical_review';
      row.nearest_place_id = nearest.id;
      row.nearest_place_name = nearest.name;
      row.nearest_distance_m = nearest.distance_m;
      return;
    }
    if (sourceDuplicates.size) {
      const duplicate = [...sourceDuplicates.values()].find(existing => {
        const existingLat = sourceCoordinate(existing, ['lat', 'latitude']);
        const existingLng = sourceCoordinate(existing, ['lng', 'lon', 'longitude']);
        return existingLat !== null && existingLng !== null
          && Math.abs(existingLat - payload.lat) < 0.00001
          && Math.abs(existingLng - payload.lng) < 0.00001;
      });
      if (duplicate) {
        skippedSourceDuplicate += 1;
        row.review_readiness = 'source_duplicate_review';
        row.source_duplicate_review_id = duplicate.id;
        return;
      }
    }
    candidates.push(row);
  });

  return {
    candidates: candidates.slice(0, args.limit),
    scanned: rows.length,
    skippedNearby,
    skippedSourceDuplicate,
    canonicalRowsPrefetched: canonicalPlaces.length,
    canonicalPrefetchTiles: canonicalPrefetch.tileCount,
    canonicalPrefetchQueries: canonicalPrefetch.queryCount,
    coordinateGridCellsBuilt: placeGrid.size,
  };
}

async function applyCandidates(client, candidates, args) {
  if (!candidates.length) return { accepted: 0 };

  const ids = candidates.map(row => row.id);
  const result = await client.query(`
    UPDATE source_review_queue
    SET
      status = 'accepted',
      decision = 'accepted',
      reviewer_notes = COALESCE(reviewer_notes, $2),
      reviewed_at = NOW(),
      reviewed_by = 'ops:accept-likely-new-source-candidates',
      updated_at = NOW()
    WHERE id = ANY($1::bigint[])
      AND entity_type = $3
      AND review_kind = 'likely_new'
      AND status = 'pending'
    RETURNING id
  `, [
    ids,
    `Accepted as likely-new import candidate via dry-run-gated ops tool with min_signals=${args.minSignals}.`,
    args.entity,
  ]);

  return { accepted: result.rowCount };
}

async function pendingStatusCounts(client, args) {
  const values = [args.entity];
  const filters = ['entity_type = $1', "review_kind = 'likely_new'"];
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
  const result = await client.query(`
    SELECT status, COUNT(*)::int AS count
    FROM source_review_queue
    WHERE ${filters.join(' AND ')}
    GROUP BY status
    ORDER BY status
  `, values);
  return result.rows;
}

function outputReport({ args, candidates, applyResult, statusCounts, filterResult }) {
  const payload = {
    generated_at: new Date().toISOString(),
    mode: args.apply ? 'apply' : 'dry-run',
    entity: args.entity,
    source: args.source || 'all',
    report_file: args.reportFile || 'all',
    state: args.state || 'all',
    min_signals: args.minSignals,
    limit: args.limit,
    scan_limit: args.scanLimit,
    nearby_radius_m: args.nearbyRadiusM,
    scanned: filterResult.scanned,
    skipped_nearby_canonical: filterResult.skippedNearby,
    skipped_source_duplicate: filterResult.skippedSourceDuplicate,
    canonical_rows_prefetched: filterResult.canonicalRowsPrefetched,
    canonical_prefetch_tiles: filterResult.canonicalPrefetchTiles,
    canonical_prefetch_queries: filterResult.canonicalPrefetchQueries,
    coordinate_grid_cells_built: filterResult.coordinateGridCellsBuilt,
    candidates: candidates.length,
    accepted: applyResult.accepted,
    status_counts: statusCounts,
    rows: candidates,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`# Accept Likely-New Source Candidates ${args.apply ? 'Apply' : 'Dry Run'}`);
  console.log('');
  console.log(`Mode: ${payload.mode}`);
  console.log(`Entity: ${payload.entity}`);
  console.log(`Source: ${payload.source}`);
  console.log(`Report file: ${payload.report_file}`);
  console.log(`State: ${payload.state}`);
  console.log(`Minimum source signals: ${payload.min_signals}/4`);
  console.log(`Rows scanned before nearby filtering: ${payload.scanned}`);
  console.log(`Nearby-canonical rows skipped: ${payload.skipped_nearby_canonical}`);
  console.log(`Same-source coordinate duplicates skipped: ${payload.skipped_source_duplicate}`);
  console.log(`Nearby duplicate radius: ${payload.nearby_radius_m}m`);
  console.log(`Canonical rows prefetched: ${payload.canonical_rows_prefetched}`);
  console.log(`Canonical prefetch tiles: ${payload.canonical_prefetch_tiles}`);
  console.log(`Canonical prefetch queries: ${payload.canonical_prefetch_queries}`);
  console.log(`Coordinate grid cells built: ${payload.coordinate_grid_cells_built}`);
  console.log(`Candidates: ${payload.candidates}`);
  console.log(`Rows accepted: ${payload.accepted}`);
  console.log('');
  console.log('## Likely-New Status Counts');
  console.log(table(['status', 'count'], statusCounts));
  console.log('');
  console.log('## Candidate Sample');
  console.log(table(
    ['id', 'report_file', 'source_name', 'source_signal_count', 'review_readiness', 'nearest_distance_m', 'source_address', 'source_website', 'source_phone'],
    candidates.slice(0, 50)
  ));
  if (!args.apply && candidates.length) {
    console.log('');
    console.log('Re-run with `--apply` to mark this bounded candidate class as accepted for later import preflight.');
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const client = new pg.Client(dbConfig());
  await client.connect();

  try {
    if (!(await tableExists(client, 'source_review_queue'))) {
      throw new Error('source_review_queue table does not exist.');
    }
    const beforeCounts = await pendingStatusCounts(client, args);
    const scannedCandidates = await fetchCandidates(client, { ...args, limit: args.scanLimit });
    const filterResult = await filterImportReadyCandidates(client, scannedCandidates, args);
    const candidates = filterResult.candidates;
    const applyResult = args.apply ? await applyCandidates(client, candidates, args) : { accepted: 0 };
    const statusCounts = args.apply ? await pendingStatusCounts(client, args) : beforeCounts;
    outputReport({ args, candidates, applyResult, statusCounts, filterResult });
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error(`accept-likely-new-source-candidates failed: ${error.message || error}`);
  process.exit(1);
});
