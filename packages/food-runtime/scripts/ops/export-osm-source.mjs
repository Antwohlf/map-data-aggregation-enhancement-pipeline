#!/usr/bin/env node

import { writeFileSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).reduce((out, value, index, values) => {
  if (value.startsWith('--')) out.push([value.slice(2), values[index + 1]]);
  return out;
}, []));

const [south, west, north, east] = String(args.bbox || '').split(',').map(Number);
const output = args.output;
if (![south, west, north, east].every(Number.isFinite) || !output) {
  throw new Error('Usage: export-osm-source.mjs --bbox south,west,north,east --output file');
}

const overpassTimeoutSeconds = positiveInt(process.env.OVERPASS_QUERY_TIMEOUT_SECONDS, 120);
const requestTimeoutMs = positiveInt(process.env.OVERPASS_REQUEST_TIMEOUT_MS, (overpassTimeoutSeconds + 30) * 1000);
const entity = String(process.env.OSM_ENTITY || 'pizza').toLowerCase();
const cuisine = entity === 'taco' ? 'mexican|taco|tex-mex|burrito' : 'pizza|pizzeria';
const query = `[out:json][timeout:${overpassTimeoutSeconds}];(nwr["amenity"="restaurant"]["cuisine"~"${cuisine}",i](${south},${west},${north},${east});nwr["amenity"="fast_food"]["cuisine"~"${cuisine}",i](${south},${west},${north},${east});nwr["disused:amenity"~"restaurant|fast_food",i](${south},${west},${north},${east});nwr["abandoned:amenity"~"restaurant|fast_food",i](${south},${west},${north},${east});nwr["demolished:amenity"~"restaurant|fast_food",i](${south},${west},${north},${east}););out center tags;`;
const endpoints = (process.env.OVERPASS_ENDPOINTS
  ? process.env.OVERPASS_ENDPOINTS.split(',')
  : [
      // This endpoint is currently the most responsive from the iMac. Keep
      // the others as failover options because provider availability changes.
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://overpass.private.coffee/api/interpreter',
    ]).map(value => value.trim()).filter(Boolean);
let payload;
const failures = [];
for (const endpoint of endpoints) {
  try {
    const response = await fetchWithHardTimeout(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'APizzaMichigan/1.0 source-pipeline' },
      body: new URLSearchParams({ data: query }),
    }, requestTimeoutMs);
    if (!response.ok) {
      failures.push(`${endpoint}: ${response.status} ${response.statusText}`);
      continue;
    }
    payload = await withHardTimeout(() => response.json(), requestTimeoutMs);
    break;
  } catch (error) {
    failures.push(`${endpoint}: ${error.message}`);
  }
}
if (!payload) throw new Error(`All Overpass endpoints failed: ${failures.join('; ')}`);
const rows = (payload.elements || []).map(element => {
  const tags = element.tags || {};
  const lat = element.lat ?? element.center?.lat;
  const lng = element.lon ?? element.center?.lon;
  const operatingStatus = tags['demolished:amenity'] ? 'demolished'
    : tags['abandoned:amenity'] ? 'abandoned'
      : tags['disused:amenity'] ? 'disused'
        : null;
  return {
    id: `osm:${element.type}/${element.id}`,
    name: tags.name || tags['name:en'] || null,
    lat,
    lng,
    address: tags['addr:full'] || [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ') || null,
    locality: tags['addr:city'] || tags['addr:town'] || tags['addr:village'] || null,
    region: tags['addr:state'] || null,
    postcode: tags['addr:postcode'] || null,
    country: tags['addr:country'] || 'US',
    website: tags.website || tags['contact:website'] || null,
    phone: tags.phone || tags['contact:phone'] || null,
    category: [tags.amenity, tags['disused:amenity'], tags['abandoned:amenity'], tags['demolished:amenity'], tags.cuisine, tags.shop].filter(Boolean).join('; '),
    operating_status: operatingStatus,
    source_url: `https://www.openstreetmap.org/${element.type}/${element.id}`,
    osm_tags: tags,
  };
}).filter(row => row.name && Number.isFinite(row.lat) && Number.isFinite(row.lng));
writeFileSync(output, `${JSON.stringify(rows, null, 2)}\n`);
console.log(JSON.stringify({ source: 'osm', entity, rows: rows.length, output }));

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function fetchWithHardTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  return withHardTimeout(
    () => fetch(url, { ...options, signal: controller.signal }),
    timeoutMs,
    () => controller.abort(),
  );
}

async function withHardTimeout(operation, timeoutMs, onTimeout = () => {}) {
  let timer;
  try {
    const operationResult = Promise.resolve().then(operation);
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        onTimeout();
        const error = new Error(`Overpass operation timed out after ${timeoutMs}ms`);
        error.code = 'ETIMEDOUT';
        reject(error);
      }, timeoutMs);
    });
    return await Promise.race([operationResult, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
