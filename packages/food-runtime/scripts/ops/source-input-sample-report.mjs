#!/usr/bin/env node
/**
 * Coverage report and controlled place_sources importer for approved samples.
 *
 * This is the generic version of the FSQ sample workflow. It normalizes small
 * source exports, filters entity-relevant records, and compares them to the current
 * canonical place table. It writes only when --apply is passed, and only to
 * place_sources for matched existing canonical rows.
 */

import pg from 'pg';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { extname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { loadRuntimeEnvironment } from '../lib/runtime-environment.mjs';
import {
  assertSourcePipelineEntity,
  defaultSourcePipelineConfigPath,
  isSourceCandidateForEntity,
} from '../lib/source-pipeline-entity.mjs';

const ENTITY_TABLES = {
  pizza: 'pizza_places',
  taco: 'taco_places',
};

export const SOURCE_CONFIGS = {
  osm: {
    label: 'OpenStreetMap / Overpass',
    license: 'ODbL-1.0',
    attribution: 'Data copyright OpenStreetMap contributors',
    sourceId: ['id', 'osm_id'],
    lat: ['lat', 'latitude'],
    lng: ['lng', 'lon', 'longitude'],
    category: ['amenity', 'cuisine', 'shop', 'category'],
    website: ['website', 'contact:website'],
    phone: ['phone', 'contact:phone'],
    closed: ['operating_status'],
    sourceUrl: ['source_url'],
  },
  fsq_os_places: {
    label: 'Foursquare OS Places',
    license: 'Apache-2.0',
    attribution: 'Copyright Foursquare Labs, Inc.',
    sourceId: ['fsq_place_id', 'fsq_id', 'id'],
    lat: ['latitude', 'lat'],
    lng: ['longitude', 'lng', 'lon'],
    category: ['fsq_category_labels', 'category_labels', 'categories', 'category_name', 'category', 'fsq_category_ids'],
    website: ['website'],
    phone: ['tel', 'phone'],
    closed: ['date_closed'],
    flags: ['unresolved_flags'],
  },
  all_the_places: {
    label: 'All the Places',
    license: 'CC0-1.0',
    attribution: 'All the Places contributors',
    sourceId: ['id', 'ref'],
    lat: ['lat', 'latitude'],
    lng: ['lng', 'lon', 'longitude'],
    category: ['amenity', 'cuisine', 'shop', 'category', 'categories'],
    website: ['website', 'contact:website'],
    phone: ['phone', 'contact:phone'],
    spider: ['@spider', 'spider'],
    sourceUrl: ['@source_uri', 'source_url'],
    closed: ['end_date'],
  },
  overture_places: {
    label: 'Overture Places',
    license: 'see-release-and-record-sources',
    attribution: 'Overture Maps Foundation, overturemaps.org',
    sourceId: ['id', 'gers_id'],
    lat: ['lat', 'latitude'],
    lng: ['lng', 'lon', 'longitude'],
    category: ['primary_category', 'basic_category', 'taxonomy', 'categories', 'category'],
    website: ['websites', 'website'],
    phone: ['phones', 'phone'],
    closed: ['operating_status'],
    confidence: ['confidence'],
    upstreamSources: ['overture_sources', 'sources'],
    release: ['overture_release'],
    adapter: ['overture_adapter'],
    categoryPolicy: ['overture_category_policy'],
    attributionUrl: ['attribution_url'],
  },
  wikidata: {
    label: 'Wikidata',
    license: 'CC0-1.0',
    attribution: 'Wikidata contributors',
    sourceId: ['item', 'qid', 'id'],
    lat: ['lat', 'latitude'],
    lng: ['lng', 'lon', 'longitude'],
    category: ['instance_of', 'cuisine', 'category', 'categories'],
    website: ['official_website', 'website'],
    phone: ['phone'],
  },
  government_open_data: {
    label: 'Government/open data',
    license: 'dataset-specific',
    attribution: 'dataset-specific',
    sourceId: ['id', 'license_id', 'permit_id', 'facility_id', 'record_id'],
    lat: ['lat', 'latitude'],
    lng: ['lng', 'lon', 'longitude'],
    category: ['facility_type', 'business_type', 'description', 'category'],
    website: ['website'],
    phone: ['phone'],
    closed: ['status'],
  },
  denue: {
    label: 'DENUE / INEGI',
    license: 'verify-before-import',
    attribution: 'INEGI DENUE',
    sourceId: ['clee', 'id', 'record_id'],
    lat: ['latitud', 'lat', 'latitude'],
    lng: ['longitud', 'lng', 'lon', 'longitude'],
    category: ['nombre_act', 'activity', 'category'],
    website: ['sitio_internet', 'website'],
    phone: ['telefono', 'phone'],
  },
  official_website: {
    label: 'Official restaurant website',
    license: 'first-party-factual-evidence',
    attribution: 'official restaurant website',
    sourceId: ['url', 'website', 'source_url', 'id'],
    lat: ['lat', 'latitude'],
    lng: ['lng', 'lon', 'longitude'],
    category: ['category', 'cuisine', 'menu_tags'],
    website: ['url', 'website', 'source_url'],
    phone: ['phone'],
  },
};

function parseArgs(argv) {
  const out = {
    source: null,
    entity: 'pizza',
    input: null,
    maxDistanceM: 100,
    limit: 1000,
    sample: 20,
    includeNonPizza: false,
    closedOnly: false,
    includeWeak: false,
    apply: false,
    reviewOutput: null,
    gridCellDegrees: 0.02,
    prefetchTileDegrees: 1,
    prefetchBatchSize: 100,
    scopeConfig: null,
    allowOutOfScope: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--source') out.source = argv[++i];
    else if (arg === '--entity') out.entity = argv[++i];
    else if (arg === '--input') out.input = argv[++i];
    else if (arg === '--max-distance-m') out.maxDistanceM = parseFloat(argv[++i]);
    else if (arg === '--limit') out.limit = parseInt(argv[++i], 10);
    else if (arg === '--sample') out.sample = parseInt(argv[++i], 10);
    else if (arg === '--include-non-pizza') out.includeNonPizza = true;
    else if (arg === '--closed-only') out.closedOnly = true;
    else if (arg === '--include-weak') out.includeWeak = true;
    else if (arg === '--apply') out.apply = true;
    else if (arg === '--review-output') out.reviewOutput = argv[++i];
    else if (arg === '--grid-cell-degrees') out.gridCellDegrees = parseFloat(argv[++i]);
    else if (arg === '--prefetch-tile-degrees') out.prefetchTileDegrees = parseFloat(argv[++i]);
    else if (arg === '--prefetch-batch-size') out.prefetchBatchSize = parseInt(argv[++i], 10);
    else if (arg === '--scope-config') out.scopeConfig = argv[++i];
    else if (arg === '--allow-out-of-scope') out.allowOutOfScope = true;
    else if (arg === '--list-sources') {
      for (const [key, config] of Object.entries(SOURCE_CONFIGS)) {
        console.log(`${key}\t${config.label}`);
      }
      process.exit(0);
    } else if (arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!SOURCE_CONFIGS[out.source]) throw new Error('Missing or invalid --source. Use --list-sources.');
  assertSourcePipelineEntity(out.entity);
  out.scopeConfig ||= defaultSourcePipelineConfigPath(out.entity);
  if (!out.input) throw new Error('Missing --input');
  if (!Number.isFinite(out.maxDistanceM) || out.maxDistanceM <= 0) throw new Error('Invalid --max-distance-m');
  if (!Number.isFinite(out.limit) || out.limit <= 0) throw new Error('Invalid --limit');
  if (!Number.isFinite(out.sample) || out.sample < 0) throw new Error('Invalid --sample');
  if (!Number.isFinite(out.gridCellDegrees) || out.gridCellDegrees <= 0) throw new Error('Invalid --grid-cell-degrees');
  if (!Number.isFinite(out.prefetchTileDegrees) || out.prefetchTileDegrees <= 0) throw new Error('Invalid --prefetch-tile-degrees');
  if (!Number.isFinite(out.prefetchBatchSize) || out.prefetchBatchSize <= 0) throw new Error('Invalid --prefetch-batch-size');
  return out;
}

function printHelp() {
  console.log(`Usage: node scripts/ops/source-input-sample-report.mjs --source <key> --input <file> [options]

Options:
  --source <key>            Source adapter. Use --list-sources.
  --entity <pizza|taco>     Canonical table to compare against (default pizza)
  --input <file>            Sample file: GeoJSON, JSON, JSONL, NDJSON, or CSV
  --max-distance-m <meters> Nearby match radius (default 100)
  --limit <n>               Maximum source rows to inspect (default 1000);
                            ATP limits eligible scoped rows and fails on overflow
  --sample <n>              Detail rows to print per bucket (default 20)
  --include-non-pizza       Compare all active records (legacy flag name)
  --closed-only             Process only closed source evidence; skip active rows
  --include-weak            Include weak_spatial_name matches in import set
  --apply                   Upsert accepted matched records into place_sources
  --review-output <file>    Write ambiguous/new review candidates to JSON
  --grid-cell-degrees <n>   Coordinate grid size for matching (default 0.02)
  --prefetch-tile-degrees <n>
                            Tile size for batched canonical prefetch (default 1)
  --prefetch-batch-size <n> Number of tiles per canonical prefetch query
                            (default 100)
  --scope-config <file>     Geographic scope config (defaults by entity)
  --allow-out-of-scope      Intentionally compare/import records outside that scope
  --list-sources            Print supported source adapters

Default mode is dry-run. With --apply, this writes source evidence only to
place_sources for matched existing rows. It never writes pizza_places or
Supabase.
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

function parseCsv(text) {
  const rows = [];
  let current = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      current.push(field);
      field = '';
    } else if (char === '\n') {
      current.push(field);
      rows.push(current);
      current = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field || current.length) {
    current.push(field);
    rows.push(current);
  }

  const [headers, ...data] = rows.filter(row => row.some(value => value.trim() !== ''));
  if (!headers) return [];
  return data.map(row => Object.fromEntries(headers.map((header, idx) => [header, row[idx] ?? ''])));
}

function featureToRow(feature) {
  const props = feature.properties || {};
  const coords = feature.geometry?.type === 'Point' ? feature.geometry.coordinates : [];
  return {
    id: feature.id,
    ...props,
    longitude: props.longitude ?? props.lon ?? props.lng ?? coords?.[0],
    latitude: props.latitude ?? props.lat ?? coords?.[1],
  };
}

function readRecords(inputPath) {
  const absPath = resolve(process.cwd(), inputPath);
  const text = readFileSync(absPath, 'utf8');
  const ext = extname(absPath).toLowerCase();
  let rows;

  if (ext === '.jsonl' || ext === '.ndjson') {
    rows = text.split('\n').map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line));
  } else if (ext === '.csv') {
    rows = parseCsv(text);
  } else {
    const parsed = JSON.parse(text);
    if (parsed?.type === 'FeatureCollection' && Array.isArray(parsed.features)) rows = parsed.features.map(featureToRow);
    else if (parsed?.type === 'Feature') rows = [featureToRow(parsed)];
    else if (Array.isArray(parsed)) rows = parsed;
    else if (Array.isArray(parsed.rows)) rows = parsed.rows;
    else if (Array.isArray(parsed.places)) rows = parsed.places;
    else if (Array.isArray(parsed.features)) rows = parsed.features.map(featureToRow);
    else throw new Error('JSON input must be an array, GeoJSON, or an object with rows/places/features');
  }

  return rows;
}

function caseMap(row) {
  const map = new Map();
  for (const [key, value] of Object.entries(row)) {
    map.set(key.toLowerCase(), value);
  }
  return map;
}

function valueFor(rowMap, keys = []) {
  for (const key of keys) {
    if (rowMap.has(key.toLowerCase())) return rowMap.get(key.toLowerCase());
  }
  return null;
}

function valuesFor(rowMap, keys = []) {
  return keys
    .filter(key => rowMap.has(key.toLowerCase()))
    .map(key => rowMap.get(key.toLowerCase()));
}

function parseMaybeJson(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function flattenStrings(value) {
  const parsed = parseMaybeJson(value);
  if (parsed == null) return [];
  if (Array.isArray(parsed)) return parsed.flatMap(flattenStrings);
  if (typeof parsed === 'object') return Object.values(parsed).flatMap(flattenStrings);
  return String(parsed).split(/[|;,]/).map(item => item.trim()).filter(Boolean);
}

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function nameTokens(value) {
  const ignored = new Set(['the', 'and', 'pizza', 'pizzeria', 'restaurant', 'bar', 'grill']);
  return normalizeText(value).split(' ').filter(token => token.length > 1 && !ignored.has(token));
}

function nameScore(a, b) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const aTokens = nameTokens(a);
  const bTokens = nameTokens(b);
  if (!aTokens.length || !bTokens.length) return 0;
  const bSet = new Set(bTokens);
  const shared = aTokens.filter(token => bSet.has(token)).length;
  return shared / Math.max(aTokens.length, bTokens.length);
}

function firstUrl(value) {
  const values = flattenStrings(value);
  return values[0] || value || null;
}

function isClosedDateValue(value) {
  const text = String(value ?? '').trim();
  if (!text || ['null', 'none', 'unknown', 'n/a', 'not available'].includes(text.toLowerCase())) return false;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) || parsed <= Date.now();
}

export function normalizeSourceRow(row, sourceKey) {
  const config = SOURCE_CONFIGS[sourceKey];
  const map = caseMap(row);
  const lat = Number(valueFor(map, config.lat));
  const lng = Number(valueFor(map, config.lng));
  const sourceId = valueFor(map, config.sourceId);
  const website = firstUrl(valueFor(map, config.website));
  const phone = firstUrl(valueFor(map, config.phone));
  const categories = [
    ...valuesFor(map, config.category).flatMap(flattenStrings),
    ...flattenStrings(row.categories),
    ...flattenStrings(row.taxonomy),
  ];
  const rawClosedValue = valueFor(map, config.closed);
  const closedValue = normalizeText(rawClosedValue);
  const flags = flattenStrings(valueFor(map, config.flags)).map(normalizeText);
  const hasClosedDate = ['all_the_places', 'fsq_os_places'].includes(sourceKey)
    && isClosedDateValue(rawClosedValue);

  return {
    source: sourceKey,
    source_label: config.label,
    source_id: sourceId ? String(sourceId).replace(/^https?:\/\/www\.wikidata\.org\/entity\//, '') : null,
    name: valueFor(map, ['name', 'label', 'title', 'business_name', 'facility_name', 'dba', 'trade_name']),
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    address: valueFor(map, ['address', 'addr:full', 'addr:street_address', 'street_address', 'address1', 'location_address']),
    locality: valueFor(map, ['locality', 'city', 'addr:city', 'municipality']),
    region: valueFor(map, ['region', 'state', 'addr:state', 'province']),
    postcode: valueFor(map, ['postcode', 'postal_code', 'zip', 'addr:postcode']),
    country: valueFor(map, ['country', 'addr:country']),
    website,
    phone,
    categories,
    spider: valueFor(map, config.spider),
    source_url: valueFor(map, config.sourceUrl) || website,
    confidence: Number(valueFor(map, config.confidence)),
    upstream_sources: parseMaybeJson(valueFor(map, config.upstreamSources)),
    source_release: valueFor(map, config.release),
    source_adapter: valueFor(map, config.adapter),
    source_category_policy: valueFor(map, config.categoryPolicy),
    attribution_url: valueFor(map, config.attributionUrl),
    is_closed: hasClosedDate || Boolean(
      closedValue &&
      [
        'closed',
        'permanently closed',
        'permanently_closed',
        'inactive',
        'out of business',
        'disused',
        'abandoned',
        'demolished',
      ].some(term => closedValue.includes(term))
    ) || flags.some(flag => ['closed', 'delete', 'doesnt exist'].includes(flag)),
  };
}

export function loadScopeConfig(path, expectedEntity) {
  const absPath = resolve(process.cwd(), path);
  if (!existsSync(absPath)) throw new Error(`Scope config not found: ${path}`);
  const parsed = JSON.parse(readFileSync(absPath, 'utf8'));
  const configuredEntity = assertSourcePipelineEntity(parsed.entity);
  if (configuredEntity !== expectedEntity) {
    throw new Error(`Scope config entity ${configuredEntity} does not match requested entity ${expectedEntity}`);
  }
  return { region_scope: parsed.region_scope || 'unconfigured', regions: Array.isArray(parsed.regions) ? parsed.regions : [] };
}

function isWithinScope(candidate, scope) {
  if (!scope.regions.length || scope.region_scope === 'global') return true;
  return scope.regions.some(region => {
    const [south, west, north, east] = region.bbox || [];
    const insideBox = [south, west, north, east].every(Number.isFinite)
      && candidate.lat >= south && candidate.lat <= north
      && candidate.lng >= west && candidate.lng <= east;
    if (!insideBox) return false;

    // Regional bboxes can cross state borders. When a source supplies an
    // explicit region code, reject a known neighboring state; records without
    // that tag remain eligible because incomplete OSM addresses are common.
    const allowedRegions = Array.isArray(region.region_codes)
      ? region.region_codes.map(value => String(value).trim().toUpperCase()).filter(Boolean)
      : [];
    if (!allowedRegions.length) return true;
    const candidateRegion = String(candidate.region || '').trim().toUpperCase();
    return !candidateRegion || allowedRegions.includes(candidateRegion);
  });
}

export function normalizeSourcePhone(value) {
  const digits = String(value || '').replace(/\D/g, '')
  return digits.length >= 7 ? digits.slice(-10) : ''
}

export function normalizeSourceUrl(value) {
  return String(value || '').trim().toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, '')
    .replace(/\/+$/, '')
}

export { isWithinScope };

export function sourceIdentifierMatch(candidate, place) {
  const sourcePhone = normalizeSourcePhone(candidate?.phone)
  const placePhone = normalizeSourcePhone(place?.phone)
  const sourceWebsite = normalizeSourceUrl(candidate?.website)
  const placeWebsite = normalizeSourceUrl(place?.website_url)
  const websiteMatches = Boolean(
    sourceWebsite && placeWebsite && sourceWebsite === placeWebsite && sourceWebsite.includes('/')
  )
  const phoneMatches = Boolean(sourcePhone && placePhone && sourcePhone === placePhone)
  return { website: websiteMatches, phone: phoneMatches, exact: websiteMatches || phoneMatches }
}

export function sourceMatchMethod(distanceM, score, identifierMatch = false) {
  if (identifierMatch && distanceM <= 100) return 'exact_identifier_nearby'
  if (distanceM <= 25 && score >= 0.99) return 'exact_name_nearby';
  if (distanceM <= 75 && score >= 0.99) return 'strong_spatial_name';
  if (distanceM <= 50 && score >= 0.6) return 'strong_spatial_name';
  if (distanceM <= 100 && score >= 0.35) return 'weak_spatial_name';
  if (distanceM <= 25) return 'spatial_only_review';
  return 'no_match';
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

function matchConfidence(match) {
  const distanceScore = Math.max(0, 1 - (match.distance_m / 100));
  const confidence = (match.name_score * 0.75) + (distanceScore * 0.25);
  if (match.match_method === 'exact_identifier_nearby') return Math.max(0.9, confidence);
  return Math.max(0.0001, Math.min(1, confidence));
}

function acceptedForImport(match, { includeWeak }) {
  if (!match) return false;
  if (match.match_method === 'exact_identifier_nearby') return true;
  if (match.match_method === 'exact_name_nearby') return true;
  if (match.match_method === 'strong_spatial_name') return true;
  return includeWeak && match.match_method === 'weak_spatial_name';
}

function buildPrefetchTiles(candidates, { maxDistanceM, tileDegrees }) {
  const tiles = new Map();
  for (const candidate of candidates) {
    const latCell = Math.floor(candidate.lat / tileDegrees);
    const lngCell = Math.floor(candidate.lng / tileDegrees);
    const key = `${latCell}:${lngCell}`;
    const existing = tiles.get(key);
    if (existing) {
      existing.minLat = Math.min(existing.minLat, candidate.lat);
      existing.maxLat = Math.max(existing.maxLat, candidate.lat);
      existing.minLng = Math.min(existing.minLng, candidate.lng);
      existing.maxLng = Math.max(existing.maxLng, candidate.lng);
    } else {
      tiles.set(key, {
        minLat: candidate.lat,
        maxLat: candidate.lat,
        minLng: candidate.lng,
        maxLng: candidate.lng,
      });
    }
  }

  const latPad = maxDistanceM / 111320;
  return [...tiles.values()].map(tile => {
    const centerLat = (tile.minLat + tile.maxLat) / 2;
    const lngPad = maxDistanceM / (111320 * Math.max(Math.cos(centerLat * Math.PI / 180), 0.01));
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

async function loadCanonicalPlaces(client, tableName, candidates, { maxDistanceM, tileDegrees, batchSize }) {
  if (!candidates.length) {
    return { rows: [], tileCount: 0, queryCount: 0 };
  }

  const tiles = buildPrefetchTiles(candidates, { maxDistanceM, tileDegrees });
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
        c.address,
        c.state,
        c.google_place_id,
        c.website_url,
        c.phone,
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

  return {
    rows: [...byId.values()],
    tileCount: tiles.length,
    queryCount,
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

function nearbyPlacesFromGrid(grid, candidate, { maxDistanceM, cellDegrees }) {
  const latCell = Math.floor(candidate.lat / cellDegrees);
  const lngCell = Math.floor(candidate.lng / cellDegrees);
  const cellRadius = Math.max(1, Math.ceil((maxDistanceM / 111320) / cellDegrees) + 1);
  const rows = [];

  for (let latOffset = -cellRadius; latOffset <= cellRadius; latOffset++) {
    for (let lngOffset = -cellRadius; lngOffset <= cellRadius; lngOffset++) {
      const places = grid.get(`${latCell + latOffset}:${lngCell + lngOffset}`) || [];
      for (const place of places) {
        const distanceM = haversineMeters(candidate.lat, candidate.lng, place.lat, place.lng);
        if (distanceM <= maxDistanceM) {
          rows.push({
            ...place,
            distance_m: distanceM,
            name_score: nameScore(candidate.name, place.name),
            identifier_match: sourceIdentifierMatch(candidate, place),
          });
        }
      }
    }
  }

  return rows
    .sort((a, b) => a.distance_m - b.distance_m)
    .slice(0, 10);
}

function bestMatch(nearby) {
  if (!nearby.length) return null;
  return nearby
    .map(row => ({ ...row, match_method: sourceMatchMethod(row.distance_m, row.name_score, row.identifier_match?.exact) }))
    .sort((a, b) => {
      const aGood = a.match_method === 'no_match' ? 0 : 1;
      const bGood = b.match_method === 'no_match' ? 0 : 1;
      if (aGood !== bGood) return bGood - aGood;
      if (a.name_score !== b.name_score) return b.name_score - a.name_score;
      return a.distance_m - b.distance_m;
    })[0];
}

function table(headers, rows) {
  if (!rows.length) return '_none_';
  const escape = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map(row => `| ${headers.map(header => escape(row[header])).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

function sourceData(candidate) {
  return {
    source_id: candidate.source_id,
    name: candidate.name,
    lat: candidate.lat,
    lng: candidate.lng,
    category: candidate.categories.slice(0, 3).join('; '),
    address: [candidate.address, candidate.locality, candidate.region].filter(Boolean).join(', '),
    locality: candidate.locality,
    region: candidate.region,
    postcode: candidate.postcode,
    country: candidate.country,
    website: candidate.website,
    phone: candidate.phone,
    is_closed: Boolean(candidate.is_closed),
    ...(candidate.source === 'overture_places' ? {
      upstream_sources: candidate.upstream_sources,
      source_release: candidate.source_release,
      source_adapter: candidate.source_adapter,
      source_category_policy: candidate.source_category_policy,
      attribution_url: candidate.attribution_url,
    } : {}),
  };
}

function sourceUrl(candidate) {
  if (candidate.source_url) return candidate.source_url;
  if (candidate.website) return candidate.website;
  if (candidate.source === 'wikidata' && candidate.source_id) {
    return `https://www.wikidata.org/wiki/${candidate.source_id}`;
  }
  return null;
}

function sourceRecordData(candidate, match) {
  return {
    source_label: candidate.source_label,
    source_id: candidate.source_id,
    name: candidate.name,
    lat: candidate.lat,
    lng: candidate.lng,
    address: candidate.address,
    locality: candidate.locality,
    region: candidate.region,
    postcode: candidate.postcode,
    country: candidate.country,
    website: candidate.website,
    phone: candidate.phone,
    categories: candidate.categories,
    spider: candidate.spider,
    source_url: sourceUrl(candidate),
    confidence: Number.isFinite(candidate.confidence) ? candidate.confidence : null,
    is_closed: Boolean(candidate.is_closed),
    ...(candidate.source === 'overture_places' ? {
      upstream_sources: candidate.upstream_sources,
      source_release: candidate.source_release,
      source_adapter: candidate.source_adapter,
      source_category_policy: candidate.source_category_policy,
      attribution_url: candidate.attribution_url,
    } : {}),
    matched_place: {
      id: match.id,
      name: match.name,
      google_place_id: match.google_place_id,
      distance_m: Number(match.distance_m.toFixed(3)),
      name_score: Number(match.name_score.toFixed(4)),
    },
  };
}

async function ensurePlaceSourcesTable(client) {
  const result = await client.query(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'place_sources'
    ) AS exists
  `);
  if (!result.rows[0].exists) {
    throw new Error('place_sources table does not exist. Run backfill-place-sources.mjs --apply-schema first.');
  }
}

async function upsertPlaceSources(client, { args, config, importable }) {
  if (!importable.length) return 0;
  await ensurePlaceSourcesTable(client);

  let written = 0;
  for (const { candidate, match } of importable) {
    if (!candidate.source_id) continue;
    const result = await client.query(`
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
      args.entity,
      match.id,
      args.source,
      candidate.source_id,
      sourceUrl(candidate),
      config.license,
      config.attribution,
      JSON.stringify(sourceRecordData(candidate, match)),
      matchConfidence(match),
      candidate.is_closed ? `closed_signal:${match.match_method}` : match.match_method,
    ]);
    written += result.rowCount;
  }
  return written;
}

function reviewCandidate(kind, item) {
  if (kind === 'ambiguous') {
    const { candidate, match } = item;
    return {
      kind,
      source: candidate.source,
      source_id: candidate.source_id,
      source_name: candidate.name,
      source_url: sourceUrl(candidate),
      source_data: sourceData(candidate),
      nearest_place: {
        id: match.id,
        name: match.name,
        google_place_id: match.google_place_id,
      distance_m: Number(match.distance_m.toFixed(3)),
      name_score: Number(match.name_score.toFixed(4)),
      identifier_match: match.identifier_match || { website: false, phone: false, exact: false },
      review_reason: match.match_method,
      },
    };
  }

  const { candidate, nearest } = item;
  return {
    kind,
    source: candidate.source,
    source_id: candidate.source_id,
    source_name: candidate.name,
    source_url: sourceUrl(candidate),
    source_data: sourceData(candidate),
    nearest_place: nearest ? {
      id: nearest.id,
      name: nearest.name,
      google_place_id: nearest.google_place_id,
      distance_m: Number(nearest.distance_m.toFixed(3)),
      name_score: Number(nearest.name_score.toFixed(4)),
    } : null,
  };
}

function writeReviewOutput(path, { args, config, counts, ambiguous, unmatched }) {
  if (!path) return;
  const absPath = resolve(process.cwd(), path);
  mkdirSync(resolve(absPath, '..'), { recursive: true });
  const payload = {
    generated_at: new Date().toISOString(),
    source: args.source,
    source_label: config.label,
    entity: args.entity,
    input: args.input,
    mode: args.apply ? 'apply' : 'dry-run',
    counts,
    ambiguous: ambiguous.map(item => reviewCandidate('ambiguous', item)),
    likely_new: unmatched.map(item => reviewCandidate('likely_new', item)),
  };
  writeFileSync(absPath, `${JSON.stringify(payload, null, 2)}\n`);
}

export function prepareSourceCandidates(inputRows, args, scope) {
  // ATP feeds have no paging cursor. A raw prefix can permanently hide local
  // restaurants behind foreign/out-of-scope rows on every scheduled refresh.
  const rows = args.source === 'all_the_places' ? inputRows : inputRows.slice(0, args.limit);
  const normalized = rows.map(row => normalizeSourceRow(row, args.source));
  const usable = normalized.filter(candidate => candidate.name && candidate.lat !== null && candidate.lng !== null);
  const active = args.closedOnly ? [] : usable.filter(candidate => !candidate.is_closed);
  const closed = usable.filter(candidate => candidate.is_closed);
  const inScope = args.allowOutOfScope ? active : active.filter(candidate => isWithinScope(candidate, scope));
  const closedInScope = args.allowOutOfScope ? closed : closed.filter(candidate => isWithinScope(candidate, scope));
  const candidateMatchesEntity = candidate => isSourceCandidateForEntity(candidate, args.entity);
  const candidates = args.includeNonPizza ? inScope : inScope.filter(candidateMatchesEntity);
  const closedCandidates = args.includeNonPizza ? closedInScope : closedInScope.filter(candidateMatchesEntity);
  if (args.source === 'all_the_places' && candidates.length + closedCandidates.length > args.limit) {
    throw new Error(`ATP eligible rows exceed --limit ${args.limit}; refusing an incomplete feed. Increase the bounded limit or narrow --scope-config.`);
  }
  return { rows, normalized, usable, active, closed, inScope, closedInScope, candidates, closedCandidates };
}

async function main() {
  const args = parseArgs(process.argv);
  const config = SOURCE_CONFIGS[args.source];
  const tableName = ENTITY_TABLES[args.entity];
  const scope = loadScopeConfig(args.scopeConfig, args.entity);
  const { rows, normalized, usable, active, closed, inScope, closedInScope, candidates, closedCandidates } = prepareSourceCandidates(readRecords(args.input), args, scope);

  const client = new pg.Client(dbConfig());
  await client.connect();

  const matched = [];
  const ambiguous = [];
  const unmatched = [];
  let rowsWritten = 0;
  let importable = [];
  let closedEvidence = [];
  let canonicalRowsPrefetched = 0;
  let gridCellsBuilt = 0;
  let prefetchTileCount = 0;
  let prefetchQueryCount = 0;

  try {
    const canonicalPrefetch = await loadCanonicalPlaces(client, tableName, [...candidates, ...closedCandidates], {
      maxDistanceM: args.maxDistanceM,
      tileDegrees: args.prefetchTileDegrees,
      batchSize: args.prefetchBatchSize,
    });
    const canonicalPlaces = canonicalPrefetch.rows;
    const placeGrid = buildPlaceGrid(canonicalPlaces, args.gridCellDegrees);
    canonicalRowsPrefetched = canonicalPlaces.length;
    gridCellsBuilt = placeGrid.size;
    prefetchTileCount = canonicalPrefetch.tileCount;
    prefetchQueryCount = canonicalPrefetch.queryCount;

    for (const candidate of candidates) {
      const nearby = nearbyPlacesFromGrid(placeGrid, candidate, {
        maxDistanceM: args.maxDistanceM,
        cellDegrees: args.gridCellDegrees,
      });
      const best = bestMatch(nearby);
      if (!best || best.match_method === 'no_match') {
        unmatched.push({ candidate, nearest: nearby[0] || null });
      } else if (best.match_method === 'spatial_only_review' || best.match_method === 'weak_spatial_name') {
        ambiguous.push({ candidate, match: best });
      } else {
        matched.push({ candidate, match: best });
      }
    }

    // Closed source records are evidence only. Match them to an existing
    // canonical place, but never change lifecycle status automatically.
    for (const candidate of closedCandidates) {
      const nearby = nearbyPlacesFromGrid(placeGrid, candidate, {
        maxDistanceM: args.maxDistanceM,
        cellDegrees: args.gridCellDegrees,
      });
      const best = bestMatch(nearby);
      if (candidate.source_id && best && best.match_method !== 'no_match' && acceptedForImport(best, { includeWeak: false })) {
        closedEvidence.push({ candidate, match: best });
      }
    }

    importable = matched.filter(({ candidate, match }) => (
      candidate.source_id &&
      acceptedForImport(match, { includeWeak: args.includeWeak })
    ));

    if (args.apply) {
      rowsWritten = await upsertPlaceSources(client, { args, config, importable: [...importable, ...closedEvidence] });
    }
  } finally {
    await client.end();
  }

  const matchedRows = matched.slice(0, args.sample).map(({ candidate, match }) => ({
    ...sourceData(candidate),
    place_id: match.id,
    place_name: match.name,
    distance_m: match.distance_m.toFixed(1),
    name_score: match.name_score.toFixed(2),
    match_method: match.match_method,
  }));

  const ambiguousRows = ambiguous.slice(0, args.sample).map(({ candidate, match }) => ({
    ...sourceData(candidate),
    nearest_place_id: match.id,
    nearest_name: match.name,
    distance_m: match.distance_m.toFixed(1),
    name_score: match.name_score.toFixed(2),
    review_reason: match.match_method,
  }));

  const unmatchedRows = unmatched.slice(0, args.sample).map(({ candidate, nearest }) => ({
    ...sourceData(candidate),
    nearest_name: nearest?.name || '',
    nearest_distance_m: nearest?.distance_m?.toFixed(1) || '',
  }));

  const counts = {
    inputRowsInspected: rows.length,
    usableRows: usable.length,
    usableActiveRows: active.length,
    closedRowsDetected: closed.length,
    closedSignalsMatched: closedEvidence.length,
    outOfScopeRowsExcluded: active.length - inScope.length,
    candidatesCompared: candidates.length,
    canonicalRowsPrefetched,
    canonicalPrefetchTiles: prefetchTileCount,
    canonicalPrefetchQueries: prefetchQueryCount,
    gridCellsBuilt,
    matchedExistingPlaces: matched.length,
    ambiguousReviewCandidates: ambiguous.length,
    likelyNewUnmatchedCandidates: unmatched.length,
    acceptedForPlaceSourcesImport: importable.length,
    placeSourcesRowsWritten: rowsWritten,
  };

  writeReviewOutput(args.reviewOutput, { args, config, counts, ambiguous, unmatched });

  console.log(`# Source input sample report: ${config.label}`);
  console.log('');
  console.log(`Generated: ${new Date().toISOString()}`);
  console.log(`Source key: ${args.source}`);
  console.log(`Entity: ${args.entity}`);
  console.log(`Comparison table: ${tableName}`);
  console.log(`Input: ${args.input}`);
  console.log(`License expectation: ${config.license}`);
  console.log(`Attribution expectation: ${config.attribution}`);
  console.log(`Mode: ${args.apply ? 'apply' : 'dry-run'}`);
  console.log(`Writes performed: ${rowsWritten}`);
  console.log('');
  console.log('## Counts');
  console.log(table(['metric', 'count'], [
    { metric: 'input rows inspected', count: counts.inputRowsInspected },
    { metric: 'rows with usable name/coordinates', count: counts.usableRows },
    { metric: 'rows with usable name/coordinates and active status', count: counts.usableActiveRows },
    { metric: 'closed source rows detected', count: counts.closedRowsDetected },
    { metric: 'closed signals matched to existing places', count: counts.closedSignalsMatched },
    { metric: 'active rows excluded by geographic scope', count: counts.outOfScopeRowsExcluded },
    { metric: args.includeNonPizza ? 'active candidates compared' : `${args.entity}-candidate active rows`, count: counts.candidatesCompared },
    { metric: 'canonical rows prefetched', count: counts.canonicalRowsPrefetched },
    { metric: 'canonical prefetch tiles', count: counts.canonicalPrefetchTiles },
    { metric: 'canonical prefetch queries', count: counts.canonicalPrefetchQueries },
    { metric: 'coordinate grid cells built', count: counts.gridCellsBuilt },
    { metric: 'matched existing places', count: counts.matchedExistingPlaces },
    { metric: 'ambiguous/review candidates', count: counts.ambiguousReviewCandidates },
    { metric: 'likely new/unmatched candidates', count: counts.likelyNewUnmatchedCandidates },
    { metric: 'accepted for place_sources import', count: counts.acceptedForPlaceSourcesImport },
    { metric: 'place_sources rows written', count: counts.placeSourcesRowsWritten },
  ]));
  if (args.reviewOutput) {
    console.log(`Review output: ${args.reviewOutput}`);
  }
  console.log('');
  console.log('## Matched Sample');
  console.log(table(['source_id', 'name', 'category', 'address', 'website', 'phone', 'place_id', 'place_name', 'distance_m', 'name_score', 'match_method'], matchedRows));
  console.log('');
  console.log('## Ambiguous Review Sample');
  console.log(table(['source_id', 'name', 'category', 'address', 'website', 'phone', 'nearest_place_id', 'nearest_name', 'distance_m', 'name_score', 'review_reason'], ambiguousRows));
  console.log('');
  console.log('## Likely New Sample');
  console.log(table(['source_id', 'name', 'category', 'address', 'website', 'phone', 'nearest_name', 'nearest_distance_m'], unmatchedRows));
}

if (process.argv[1]
  && existsSync(resolve(process.argv[1]))
  && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) {
  main().catch(error => {
    console.error(`source-input-sample-report failed: ${error.message || error}`);
    process.exit(1);
  });
}
