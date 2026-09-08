#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { selectSourcePipelineRegions } from '../lib/source-pipeline-scope.mjs';
import { sourceAutoLinkArguments } from '../lib/source-auto-link-policy.mjs';
import { executeTrustedHostStages } from '@map-pipeline/executor/trusted-host';
import { createFoodSourceStages } from '../lib/food-source-stages.mjs';
import { summarizeOsmManifest } from '../lib/osm-refresh-summary.mjs';
import {
  assertSourcePipelineEntity,
  sourceInputSampleReportArguments,
  sourcePipelineOsmOutputPath,
  sourcePipelineReviewOutputPath,
} from '../lib/source-pipeline-entity.mjs';

const ROOT = process.cwd();
const CONFIG_PATH = resolve(ROOT, process.env.SOURCE_PIPELINE_CONFIG || 'config/source-pipeline.json');
const STATE_PATH = resolve(ROOT, process.env.SOURCE_PIPELINE_STATE || `scripts/.${basename(CONFIG_PATH, '.json')}-state.json`);
const LAST_REPORT_PATH = resolve(ROOT, process.env.SOURCE_PIPELINE_LAST_REPORT || `scripts/.${basename(CONFIG_PATH, '.json')}-last-report.json`);
const LAST_DRY_RUN_PATH = resolve(ROOT, process.env.SOURCE_PIPELINE_LAST_DRY_RUN || `scripts/.${basename(CONFIG_PATH, '.json')}-last-dry-run.json`);
const LOCK_PATH = '/tmp/apizzamichigan/source-pipeline.lock';
const NODE = process.execPath;
const OSM_PIPELINE_TIMEOUT_MS = Number.parseInt(process.env.OSM_PIPELINE_TIMEOUT_MS || '', 10) || 1200000;

function args(argv) {
  const out = { apply: false, plan: false, source: 'all', regions: null, maxWorkUnits: 2, maxNewPlaces: 5, json: false, force: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--apply') out.apply = true;
    else if (argv[i] === '--dry-run') out.apply = false;
    else if (argv[i] === '--plan') out.plan = true;
    else if (argv[i] === '--source') out.source = argv[++i];
    else if (argv[i] === '--regions') out.regions = argv[++i].split(',').map(value => value.trim().toUpperCase()).filter(Boolean);
    else if (argv[i] === '--max-work-units') out.maxWorkUnits = Number(argv[++i]);
    else if (argv[i] === '--max-new-places') out.maxNewPlaces = Number(argv[++i]);
    else if (argv[i] === '--force') out.force = true;
    else if (argv[i] === '--json') out.json = true;
    else if (argv[i] === '--help') { console.log('Usage: node scripts/ops/run-source-pipeline.mjs [--plan|--dry-run|--apply] [--source key|all] [--regions MI,NY] [--max-work-units n] [--max-new-places n] [--force] [--json]'); process.exit(0); }
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!Number.isInteger(out.maxWorkUnits) || out.maxWorkUnits < 1) throw new Error('Invalid --max-work-units');
  if (!Number.isInteger(out.maxNewPlaces) || out.maxNewPlaces < 0) throw new Error('Invalid --max-new-places');
  return out;
}

function loadJson(path, fallback) { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback; }
function saveJson(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }
function parseJsonOutput(output) {
  try { return JSON.parse(output); } catch { return null; }
}
function run(command, commandArgs, { timeout = 120000, env = process.env } = {}) {
  // Keep adapters attached to the launchd process group so a job restart cannot
  // orphan an exporter that continues writing a resumable manifest. The OSM
  // tile runner applies its own direct-child timeout for nested requests.
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    timeout,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM') {
    killProcess(result.pid);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} failed: ${String(result.stderr || result.stdout).trim().slice(-3000)}`);
  return String(result.stdout || '').trim();
}
function killProcess(pid) {
  if (!pid) return;
  try { process.kill(Number(pid), 'SIGTERM'); } catch {}
  try { process.kill(Number(pid), 'SIGKILL'); } catch {}
}
function acquireLock() {
  mkdirSync(dirname(LOCK_PATH), { recursive: true });
  try { mkdirSync(LOCK_PATH); writeFileSync(`${LOCK_PATH}/owner.json`, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })); return true; }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner = null;
    try { owner = loadJson(`${LOCK_PATH}/owner.json`, null); } catch { owner = null; }
    if (owner?.pid && !isProcessAlive(owner.pid)) {
      rmSync(LOCK_PATH, { recursive: true, force: true });
      try { mkdirSync(LOCK_PATH); writeFileSync(`${LOCK_PATH}/owner.json`, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })); return true; }
      catch (retryError) { if (retryError.code === 'EEXIST') return false; throw retryError; }
    }
    return false;
  }
}
function isProcessAlive(pid) {
  try { process.kill(Number(pid), 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}
function releaseLock() { rmSync(LOCK_PATH, { recursive: true, force: true }); }
function due(entry, now) { return !entry?.last_success || (now - Date.parse(entry.last_success)) >= entry.cadence_hours * 3600000; }
function stampReport(source, region, entity, output) {
  const report = sourcePipelineReviewOutputPath(ROOT, source, region, entity);
  return { input: output, report, reportFile: basename(report) };
}
function osmManifestPath(regionalOutput, bbox, step) {
  const current = `${regionalOutput}.manifest.json`;
  if (!existsSync(current)) return current;
  try {
    const manifest = loadJson(current, null);
    const matchesBbox = Array.isArray(manifest?.bbox)
      && manifest.bbox.length === bbox.length
      && manifest.bbox.every((value, index) => Number(value) === Number(bbox[index]));
    if (matchesBbox && Number(manifest.step) === Number(step)) return current;
  } catch {}
  const suffix = String(step).replace('.', 'p');
  return `${regionalOutput.replace(/\.json$/, '')}.step-${suffix}.json.manifest.json`;
}

function osmBacklog(region, osmConfig, entity) {
  const regionalOutput = sourcePipelineOsmOutputPath(ROOT, region.key, entity);
  const step = Number(osmConfig.tile_step || 0.5);
  const manifestPath = osmManifestPath(regionalOutput, region.bbox, step);
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = loadJson(manifestPath, null);
    const refreshAfterMs = Number(osmConfig.refresh_after_hours || 720) * 60 * 60 * 1000;
    return summarizeOsmManifest(manifest, { refreshAfterHours: refreshAfterMs / (60 * 60 * 1000) }).refreshQueueTiles;
  } catch {
    return null;
  }
}

function selectOsmRegion(regions, osmConfig, entity, cursor = 0) {
  const scored = regions.map((region, index) => ({
    region,
    index,
    backlog: osmBacklog(region, osmConfig, entity),
  })).filter(item => item.backlog !== null && item.backlog > 0);
  if (!scored.length) return regions[Number(cursor || 0) % regions.length];
  return scored.sort((left, right) => right.backlog - left.backlog || left.index - right.index)[0].region;
}
function assertSourceCapabilities(source, sourceConfig, required) {
  const capabilities = sourceConfig?.capabilities || [];
  if (!required.every(capability => capabilities.includes(capability))) {
    throw new Error(`Source ${source} lacks required capabilities: ${required.join(', ')}`);
  }
}
function splitBbox(bbox) {
  const [south, west, north, east] = bbox;
  const tiles = [];
  for (let lat = 0; lat < 4; lat += 1) {
    for (let lng = 0; lng < 4; lng += 1) {
      tiles.push([
        south + ((north - south) * lat) / 4,
        west + ((east - west) * lng) / 4,
        south + ((north - south) * (lat + 1)) / 4,
        west + ((east - west) * (lng + 1)) / 4,
      ]);
    }
  }
  return tiles;
}
function runSourceAcquisition(source, region, output, config, state) {
  const [south, west, north, east] = region.bbox;
  let osmProvenanceRefresh = null;
  if (source === 'osm') {
    // Keep the regional export and manifest stable across hourly runs. The
    // tiled runner resumes completed Overpass tiles instead of re-querying a
    // whole region or losing progress when one endpoint fails.
    const regionalOutput = sourcePipelineOsmOutputPath(ROOT, region.key, config.entity);
    const step = Number(config.sources.osm.tile_step || 0.5);
    const defaultTilesPerRun = Number(config.sources.osm.tiles_per_run || 1);
    const tilesPerRunByRegion = config.sources.osm.tiles_per_run_by_region || {};
    const tilesPerRun = Number(tilesPerRunByRegion[region.key] || defaultTilesPerRun);
    const tileTimeout = Number((config.sources.osm.tile_timeout_ms_by_region || {})[region.key] || config.sources.osm.tile_timeout_ms || 180000);
    const refreshAfterHours = Number(config.sources.osm.refresh_after_hours || 720);
    const requestTimeout = Number((config.sources.osm.overpass_request_timeout_ms_by_region || {})[region.key] || config.sources.osm.overpass_request_timeout_ms || 90000);
    const queryTimeout = Number((config.sources.osm.overpass_query_timeout_seconds_by_region || {})[region.key] || config.sources.osm.overpass_query_timeout_seconds || 90);
    const manifest = osmManifestPath(regionalOutput, region.bbox, step);
    mkdirSync(dirname(regionalOutput), { recursive: true });
    run(NODE, [
      'scripts/ops/export-osm-tiles.mjs',
      '--bbox', region.bbox.join(','),
      '--step', String(step),
      '--max-tiles', String(tilesPerRun),
      '--output', regionalOutput,
      '--manifest', manifest,
      ...(config.sources.osm.retry_failed ? ['--retry-failed'] : []),
    ], { timeout: OSM_PIPELINE_TIMEOUT_MS, env: { ...process.env, OSM_ENTITY: config.entity, OSM_TILE_TIMEOUT_MS: String(tileTimeout), OSM_REFRESH_AFTER_HOURS: String(refreshAfterHours), OVERPASS_REQUEST_TIMEOUT_MS: String(requestTimeout), OVERPASS_QUERY_TIMEOUT_SECONDS: String(queryTimeout) } });
    writeFileSync(output, readFileSync(regionalOutput));
  } else if (source === 'overture_places') {
    const overtureOutput = resolve(ROOT, 'data/source-inputs', `overture_places-${region.key}.json`);
    const overtureManifest = `${overtureOutput}.manifest.json`;
    run(resolve(ROOT, 'scripts/.fsq-venv/bin/python'), ['scripts/ops/export-overture-tiles.py', '--bbox', region.bbox.join(','), '--step', String(config.sources.overture_places.tile_step || 1), '--max-tiles', String(config.sources.overture_places.tiles_per_run || 1), '--output', overtureOutput, '--manifest', overtureManifest, '--limit', String(config.limits.candidate_rows_per_source)], { timeout: 1200000 });
    writeFileSync(output, readFileSync(overtureOutput));
  } else if (source === 'wikidata') {
    run(NODE, ['scripts/ops/export-wikidata-source.mjs', '--output', output, '--limit', String(config.sources.wikidata.rows_per_run || 50)], { timeout: 240000 });
  } else if (source === 'fsq_os_places') {
    run(resolve(ROOT, 'scripts/.fsq-venv/bin/python'), ['scripts/ops/export-fsq-hf-parquet-sample.py', '--query', '', '--country', 'US', '--max-files', String(config.sources.fsq_os_places.max_files), '--limit', String(config.limits.candidate_rows_per_source), '--output', output], { timeout: 1800000 });
  } else throw new Error(`No adapter for ${source}`);
  return { input: output, osmProvenanceRefresh };
}

function runAdapter(source, region, output, config, state) {
  const stages = createFoodSourceStages({
    source,
    adapterIds: config.stageAdapters?.[source],
    acquire: () => runSourceAcquisition(source, region, output, config, state),
    match: (_, inputs) => {
      const paths = stampReport(source, region.key, config.entity, inputs.acquire.input);
      run(NODE, sourceInputSampleReportArguments({
        source, input: paths.input, entity: config.entity, scopeConfig: CONFIG_PATH,
        limit: config.limits.candidate_rows_per_source, reviewOutput: paths.report, apply: config.apply,
      }), { timeout: 600000 });
      return paths;
    },
    review: (_, inputs) => {
      const paths = inputs.match;
      let osmProvenanceRefresh = null;
      if (config.apply) {
        if (source === 'osm') {
          osmProvenanceRefresh = parseJsonOutput(run(NODE, [
            'scripts/ops/refresh-osm-place-sources.mjs', '--input', paths.input, '--entity', config.entity,
            '--states', (config.operational_regions || []).join(','),
            '--max-updates', String(config.sources.osm.provenance_refresh_limit_per_run || 1000), '--apply', '--json',
          ], { timeout: 180000 }));
        }
        run(NODE, ['scripts/ops/import-source-review-queue.mjs', '--input-files', paths.report, '--entity', config.entity, '--apply'], { timeout: 180000 });
        const autoLinkArgs = sourceAutoLinkArguments(source);
        if (autoLinkArgs.length) run(NODE, ['scripts/ops/auto-link-source-review-queue.mjs', '--entity', config.entity, '--source', source, ...autoLinkArgs, '--max-distance-m', '100', '--limit', '100', '--apply'], { timeout: 180000 });
      }
      return { ...paths, osmProvenanceRefresh };
    },
  });
  const result = executeTrustedHostStages({ definition: stages.definition, registry: stages.registry, context: { source, entity: config.entity, region: region.key, apply: config.apply } });
  return result.outputs.review;
}

function runAtp(region, config, state, apply, maxSpiders) {
  const manifest = loadJson(resolve(ROOT, 'config/atp-pizza-spiders.json'), { spiders: [] });
  const enabled = manifest.spiders.filter(row => row.import_enabled && row.status === 'active').map(row => row.spider);
  const index = Number(state.all_the_places?.spider_index || 0) % Math.max(enabled.length, 1);
  const selected = Array.from({ length: Math.min(maxSpiders, enabled.length) }, (_, i) => enabled[(index + i) % enabled.length]);
  if (!selected.length) return null;
  const command = ['scripts/ops/import-atp-spiders.mjs', '--spiders', selected.join(','), '--entity', config.entity, '--scope-config', CONFIG_PATH, '--import-review-queue', ...(apply ? ['--apply', '--apply-review-queue'] : [])];
  const output = run(NODE, command, { timeout: 900000 });
  return { selected, output };
}
function processNew(reportFile, source, config, apply, maxNewPlaces) {
  const sourceConfig = config.sources[source];
  if (!apply || !sourceConfig?.auto_create || maxNewPlaces <= 0) return;
  assertSourceCapabilities(source, sourceConfig, ['discover', 'enrich_evidence']);
  run(NODE, ['scripts/ops/process-reviewed-new-batch.mjs', '--entity', config.entity, '--source', source, '--report-file', reportFile, '--min-signals', '4', '--accept-limit', String(maxNewPlaces), '--import-limit', String(maxNewPlaces), '--nearby-radius-m', '150', '--apply', '--run-scrape'], { timeout: 900000 });
}
function runWebsiteDrain(config, apply) {
  if (!apply || !config.sources.official_website.enabled) return 'dry-run';
  // The launchd scraper is the single production owner of website jobs. Do
  // not start a second foreground worker from the hourly source pipeline.
  // Operators can still opt into a bounded manual drain when diagnosing a
  // scraper-specific issue.
  if (process.env.SOURCE_PIPELINE_RUN_SCRAPER !== '1') {
    run(NODE, ['scripts/ops/record-website-provenance.mjs', '2'], { timeout: 180000, env: { ...process.env, APIZZA_SYNC_ENTITY: config.entity } });
    return 'managed-launchd-scraper';
  }
  const env = { ...process.env, SCRAPE_REQUEUE_BATCH: '0', SCRAPE_MAX_JOBS: String(config.limits.website_jobs_per_run), SCRAPE_CANT_SCRAPE_LOG: '/tmp/apizzamichigan/scrape-cant-scrape.jsonl' };
  const output = run(NODE, ['scripts/enrichment/agents/web-scraper.mjs', '--worker-id', 'source-pipeline-scraper', '--max-jobs', String(config.limits.website_jobs_per_run)], { timeout: 1200000, env });
  run(NODE, ['scripts/ops/record-website-provenance.mjs', '2'], { timeout: 180000, env: { ...process.env, APIZZA_SYNC_ENTITY: config.entity } });
  return output.slice(-1000);
}

function promoteContactFields(config, apply) {
  if (!apply) return 'dry-run';
  const maxUpdates = Number(config.limits.contact_promotions_per_run || 50);
  const output = run(NODE, [
    'scripts/ops/promote-source-contact-fields.mjs',
    '--entity', config.entity,
    '--fields', 'website_url,phone',
    '--max-updates', String(maxUpdates),
    '--apply',
  ], { timeout: 180000 });
  return output.slice(-2000);
}

function populateClassifierQueue(config, apply, regions) {
  if (!apply) return 'disabled';
  const limit = Number(config.limits.classify_queue_jobs_per_region_per_run || 50);
  const outputs = [];
  for (const state of regions.map(region => region.key)) {
    outputs.push(run(NODE, [
      'scripts/enrichment/populate-classify-from-db.mjs',
      '--type', config.entity,
      '--state', state,
      '--limit', String(limit),
      '--skip-existing',
    ], { timeout: 180000 }).slice(-1200));
  }
  return outputs.join('\n');
}

const options = args(process.argv);
const config = loadJson(CONFIG_PATH, null);
if (!config) throw new Error(`Missing ${CONFIG_PATH}`);
assertSourcePipelineEntity(config.entity);
const regions = selectSourcePipelineRegions(config, options.regions);
if (!regions.length) {
  const requested = options.regions?.length ? ` --regions ${options.regions.join(',')}` : '';
  throw new Error(`No configured operational regions matched${requested}`);
}
const now = Date.now();
const state = loadJson(STATE_PATH, { sources: {}, region_index: 0, last_run: null });
const selected = options.source === 'all' ? Object.keys(config.sources) : options.source.split(',').map(value => value.trim());

if (options.plan) {
  const plan = {
    generated_at: new Date(now).toISOString(),
    mode: 'plan',
    source: options.source,
    regions: regions.map(region => region.key),
    max_work_units: options.maxWorkUnits,
    force: options.force,
    work_units: [],
    skipped: [],
  };
  let plannedWorkUnits = 0;
  for (const source of selected) {
    const sourceConfig = config.sources[source];
    if (!sourceConfig?.enabled) {
      plan.skipped.push({ source, reason: 'disabled' });
      continue;
    }
    if (plannedWorkUnits >= options.maxWorkUnits) {
      plan.skipped.push({ source, reason: 'max_work_units_reached' });
      continue;
    }
    const sourceState = state.sources[source] || {};
    if (!options.force && !due({ ...sourceConfig, ...sourceState }, now)) {
      plan.skipped.push({
        source,
        reason: 'cadence_not_due',
        last_success: sourceState.last_success || null,
        cadence_hours: sourceConfig.cadence_hours,
      });
      continue;
    }
    const regionIndex = Number.isInteger(Number(sourceState.region_index))
      ? Number(sourceState.region_index)
      : 0;
    const region = source === 'osm'
      ? selectOsmRegion(regions, config.sources.osm, config.entity, regionIndex)
      : regions[regionIndex % regions.length];
    plan.work_units.push({
      source,
      region: region?.key || null,
      last_success: sourceState.last_success || null,
      cadence_hours: sourceConfig.cadence_hours,
      capabilities: sourceConfig.capabilities || [],
    });
    plannedWorkUnits += 1;
  }
  if (options.json) console.log(JSON.stringify(plan, null, 2));
  else {
    console.log(`source pipeline plan: due=${plan.work_units.length} skipped=${plan.skipped.length}`);
    for (const workUnit of plan.work_units) console.log(`  - ${workUnit.source}${workUnit.region ? ` (${workUnit.region})` : ''}`);
    for (const skipped of plan.skipped) console.log(`  - ${skipped.source}: ${skipped.reason}`);
  }
  process.exit(0);
}

if (!acquireLock()) { console.log('source pipeline already running; exiting'); process.exit(0); }
const report = { started_at: new Date(now).toISOString(), mode: options.apply ? 'apply' : 'dry-run', work_units: [], skipped: [], errors: [] };
let workUnits = 0;
try {
  for (const source of selected) {
    if (workUnits >= options.maxWorkUnits) {
      report.skipped.push({ source, reason: 'max_work_units_reached' });
      continue;
    }
    if (!config.sources[source]?.enabled) {
      report.skipped.push({ source, reason: 'disabled' });
      continue;
    }
    if (!options.force && !due({ ...config.sources[source], ...state.sources[source] }, now)) {
      report.skipped.push({ source, reason: 'cadence_not_due' });
      continue;
    }
    const sourceState = state.sources[source] || {};
    // Each source owns its geographic cursor. A failed OSM tile or an
    // intentionally slower source must not advance the region schedule for
    // every other adapter.
    const rotationThreshold = Number(config.sources[source]?.failure_rotation_threshold || 0);
    if (rotationThreshold > 0
      && Number(sourceState.consecutive_failures || 0) >= rotationThreshold
      && regions.length > 1) {
      sourceState.region_index = (Number(sourceState.region_index || 0) + 1) % regions.length;
      sourceState.consecutive_failures = 0;
      sourceState.last_error = `${sourceState.last_error || 'source failure'}\nRotated to next region before retry after ${rotationThreshold} consecutive failures; prior region remains resumable.`;
      state.sources[source] = sourceState;
    }
    const regionIndex = Number.isInteger(Number(sourceState.region_index))
      ? Number(sourceState.region_index)
      : 0;
    const region = source === 'osm'
      ? selectOsmRegion(regions, config.sources.osm, config.entity, regionIndex)
      : regions[regionIndex % regions.length];
    try {
      const sourceConfig = config.sources[source];
      if (!sourceConfig?.capabilities?.includes('enrich_evidence')) {
        throw new Error(`Source ${source} is enabled without enrich_evidence capability`);
      }
      if (source === 'official_website') {
        assertSourceCapabilities(source, sourceConfig, ['match_existing', 'enrich_evidence']);
        report.website = runWebsiteDrain(config, options.apply);
        state.sources[source] = {
          ...(state.sources[source] || {}),
          last_attempt: new Date().toISOString(),
          last_success: new Date().toISOString(),
          last_error: null,
        };
        continue;
      }
      if (source === 'all_the_places') {
        assertSourceCapabilities(source, sourceConfig, ['discover', 'match_existing', 'enrich_evidence']);
        const result = runAtp(region, config, state.sources, options.apply, config.sources[source].spiders_per_run || 3);
        report.work_units.push({ source, region: region.key, spiders: result?.selected || [] });
        if (options.apply) {
          report.auto_link = run(NODE, ['scripts/ops/auto-link-source-review-queue.mjs', '--entity', config.entity, '--source', source, '--exact-identifiers', '--min-exact-identifiers', '3', '--max-distance-m', '10', '--limit', '100', ...(options.apply ? ['--apply'] : [])], { timeout: 180000 }).slice(-2000);
        }
        for (const spider of result?.selected || []) {
          processNew(resolve(ROOT, 'reports/source-review', `${spider}-review.json`), source, config, options.apply, options.maxNewPlaces);
        }
        state.sources[source] = {
          ...(state.sources[source] || {}),
          last_success: new Date().toISOString(),
          spider_index: (Number(state.sources[source]?.spider_index || 0) + (result?.selected?.length || 0)),
          region_index: (Number(state.sources[source]?.region_index || 0) + 1) % regions.length,
        };
      } else {
        assertSourceCapabilities(source, sourceConfig, ['match_existing', 'enrich_evidence']);
        if (sourceConfig.auto_create) assertSourceCapabilities(source, sourceConfig, ['discover']);
        const regionsPerRun = Math.max(1, Math.min(
          Number(sourceConfig.regions_per_run || 1),
          options.maxWorkUnits - workUnits,
        ));
        const startingRegionIndex = Number(sourceState.region_index || 0);
        for (let regionOffset = 0; regionOffset < regionsPerRun; regionOffset += 1) {
          const region = regions[(startingRegionIndex + regionOffset) % regions.length];
          const output = resolve(ROOT, 'data/source-inputs', `${source}-${region.key}-${now}-${regionOffset}.json`);
          mkdirSync(dirname(output), { recursive: true });
          const paths = runAdapter(source, region, output, { ...config, apply: options.apply }, state);
          report.work_units.push({
            source,
            region: region.key,
            report_file: paths.reportFile,
            ...(paths.osmProvenanceRefresh ? { osm_provenance_refresh: paths.osmProvenanceRefresh } : {}),
          });
          processNew(paths.report, source, config, options.apply, options.maxNewPlaces);
          state.sources[source] = {
            ...(state.sources[source] || {}),
            region_index: (startingRegionIndex + regionOffset + 1) % regions.length,
          };
          workUnits += 1;
        }
      }
      state.sources[source] = {
        ...(state.sources[source] || {}),
        last_attempt: new Date().toISOString(),
        last_success: new Date().toISOString(),
        last_error: null,
        consecutive_failures: 0,
      };
      if (source === 'osm') {
        state.sources[source].region_index = (regions.findIndex(candidate => candidate.key === region.key) + 1) % regions.length;
      }
      if (!['official_website', 'osm'].includes(source)) workUnits += 1;
    } catch (error) {
      const message = error?.stack || error?.message || String(error);
      report.errors.push({ source, message });
      state.sources[source] = {
        ...(state.sources[source] || {}),
        last_attempt: new Date().toISOString(),
        last_error: message.slice(-5000),
      };
      const failures = Number(state.sources[source].consecutive_failures || 0) + 1;
      const rotationThreshold = Number(config.sources[source]?.failure_rotation_threshold || 0);
      state.sources[source].consecutive_failures = failures;
      if (rotationThreshold > 0 && failures >= rotationThreshold && regions.length > 1) {
        state.sources[source].region_index = (Number(state.sources[source].region_index || 0) + 1) % regions.length;
        state.sources[source].consecutive_failures = 0;
        state.sources[source].last_error = `${message.slice(-4500)}\nRotated to next region after ${failures} consecutive failures; prior region remains resumable.`;
      }
    }
  }
  // Do not run downstream contact promotion on a no-op scheduler tick. A
  // cadence-gated or failed source should not cause unrelated evidence to be
  // promoted merely because the pipeline was invoked with --apply.
  if (options.apply && workUnits > 0) {
    report.contact_promotion = promoteContactFields(config, options.apply);
  }
  if (options.apply) {
    report.classifier_queue = populateClassifierQueue(config, options.apply, regions);
  }
  // Keep the legacy aggregate cursor for older status tooling, but derive
  // actual work selection from each source's cursor above.
  if (workUnits) state.region_index = (state.region_index + 1) % regions.length;
  state.last_run = new Date().toISOString();
  if (options.apply) saveJson(STATE_PATH, state);
  report.finished_at = new Date().toISOString();
  // Keep the last applied scheduler result separate from dry-run diagnostics.
  // A manual dry run must never make health checks report that production
  // automation succeeded or failed when it did not actually apply work.
  saveJson(options.apply ? LAST_REPORT_PATH : LAST_DRY_RUN_PATH, report);
  console.log(options.json ? JSON.stringify(report, null, 2) : `source pipeline ${report.mode}: work_units=${workUnits} errors=${report.errors.length}`);
  // A source-level failure is recorded in state and the JSON report for the
  // health/alerting layer. The other sources still get their work units, but
  // the overall scheduler result remains non-zero so automation can alert.
  if (report.errors.length && !options.json) {
    console.log(`source pipeline warnings: ${report.errors.map(error => error.source).join(', ')}`);
  }
  // Preserve partial progress, but make the scheduler result observable as a
  // failure to launchd, shell callers, and external alerting.
  if (report.errors.length) process.exitCode = 1;
} finally { releaseLock(); }
