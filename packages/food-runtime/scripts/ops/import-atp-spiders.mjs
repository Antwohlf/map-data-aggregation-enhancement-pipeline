#!/usr/bin/env node
/**
 * Download and process selected All the Places spider outputs.
 *
 * This wraps source-input-sample-report so ATP runs are repeatable and keep
 * review JSON artifacts for ambiguous/new rows.
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { basename, join, resolve } from 'path';
import { defaultSourcePipelineConfigPath } from '../lib/source-pipeline-entity.mjs';

const DEFAULT_BASE_URL = 'https://data.alltheplaces.xyz/runs/latest/output';
const DEFAULT_LATEST_URL = 'https://data.alltheplaces.xyz/runs/latest.json';
const DEFAULT_MANIFEST_PATH = 'config/atp-pizza-spiders.json';

function parseArgs(argv) {
  const args = {
    spiders: [],
    entity: 'pizza',
    outputDir: 'reports/source-review',
    downloadDir: '/tmp',
    baseUrl: DEFAULT_BASE_URL,
    latestUrl: DEFAULT_LATEST_URL,
    manifestPath: DEFAULT_MANIFEST_PATH,
    useDefaultSpiders: false,
    manifestGroups: [],
    listManifest: false,
    preflight: true,
    preflightOnly: false,
    importReviewQueue: false,
    applyReviewQueue: false,
    applyReviewSchema: false,
    apply: false,
    sample: 3,
    limit: 20000,
    scopeConfig: null,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--spider') args.spiders.push(argv[++i]);
    else if (arg === '--spiders') args.spiders.push(...argv[++i].split(',').map(item => item.trim()).filter(Boolean));
    else if (arg === '--default-spiders') args.useDefaultSpiders = true;
    else if (arg === '--group') args.manifestGroups.push(argv[++i]);
    else if (arg === '--groups') args.manifestGroups.push(...argv[++i].split(',').map(item => item.trim()).filter(Boolean));
    else if (arg === '--list-manifest') args.listManifest = true;
    else if (arg === '--entity') args.entity = argv[++i];
    else if (arg === '--output-dir') args.outputDir = argv[++i];
    else if (arg === '--download-dir') args.downloadDir = argv[++i];
    else if (arg === '--base-url') args.baseUrl = argv[++i].replace(/\/$/, '');
    else if (arg === '--latest-url') args.latestUrl = argv[++i];
    else if (arg === '--manifest') args.manifestPath = argv[++i];
    else if (arg === '--skip-preflight') args.preflight = false;
    else if (arg === '--preflight-only') args.preflightOnly = true;
    else if (arg === '--import-review-queue') args.importReviewQueue = true;
    else if (arg === '--apply-review-queue') {
      args.importReviewQueue = true;
      args.applyReviewQueue = true;
    }
    else if (arg === '--apply-review-schema') args.applyReviewSchema = true;
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--sample') args.sample = parseInt(argv[++i], 10);
    else if (arg === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (arg === '--scope-config') args.scopeConfig = argv[++i];
    else if (arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const manifest = loadManifest(args.manifestPath);
  if (args.listManifest) {
    printManifest(manifest);
    process.exit(0);
  }
  if (args.useDefaultSpiders || args.manifestGroups.length) {
    args.spiders.push(...manifestSpiders(manifest, { groups: args.manifestGroups }));
  }
  args.spiders = [...new Set(args.spiders)];
  if (!args.spiders.length) throw new Error('Pass --spider <name>, --spiders <a,b>, --group <name>, or --default-spiders');
  if (!['pizza', 'taco'].includes(args.entity)) throw new Error('Invalid --entity');
  args.scopeConfig ||= defaultSourcePipelineConfigPath(args.entity);
  if (!Number.isFinite(args.sample) || args.sample < 0) throw new Error('Invalid --sample');
  if (!Number.isFinite(args.limit) || args.limit <= 0) throw new Error('Invalid --limit');
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/ops/import-atp-spiders.mjs [options]

Options:
  --spider <name>       Add one ATP spider name
  --spiders <a,b,c>     Add comma-separated spider names
  --default-spiders     Use the current APizza pizza spider shortlist
  --group <name>        Use import-enabled spiders from a manifest group
  --groups <a,b,c>      Use import-enabled spiders from manifest groups
  --list-manifest       Print manifest groups/spiders and exit
  --entity <pizza|taco> Canonical entity to compare against (default pizza)
  --output-dir <dir>    Review JSON directory (default reports/source-review)
  --download-dir <dir>  GeoJSON download directory (default /tmp)
  --base-url <url>      ATP output base URL (default latest run output)
  --latest-url <url>    ATP latest metadata URL for spider preflight
  --manifest <file>     Manifest for --default-spiders
                        (default config/atp-pizza-spiders.json)
  --skip-preflight      Do not validate spider names against ATP run stats
  --preflight-only      Validate spider names and exit before downloading
  --import-review-queue Dry-run import generated review JSONs into source_review_queue
  --apply-review-queue  Upsert generated review JSONs into source_review_queue
  --apply-review-schema Create source_review_queue schema before queue import
  --apply               Write accepted matches to place_sources
  --sample <n>          Printed sample rows per bucket (default 3)
  --limit <n>           Max eligible scoped rows per spider (default 20000);
                       oversized feeds fail rather than silently truncate
  --scope-config <file> Geographic scope config (defaults by entity)

Without --apply, this only downloads inputs and writes review JSON.
Review queue import never creates canonical places or writes Supabase.
`);
}

function loadManifest(manifestPath) {
  const absPath = resolve(process.cwd(), manifestPath);
  if (!existsSync(absPath)) {
    throw new Error(`ATP spider manifest not found: ${manifestPath}`);
  }
  return JSON.parse(readFileSync(absPath, 'utf8'));
}

function manifestSpiders(manifest, { groups = [] } = {}) {
  const selectedGroups = new Set(groups.map(group => String(group || '').trim()).filter(Boolean));
  const spiders = (manifest.spiders || [])
    .filter(row => row.import_enabled)
    .filter(row => selectedGroups.size === 0 || selectedGroups.has(row.group))
    .map(row => row.spider)
    .filter(Boolean);
  if (!spiders.length) {
    const suffix = selectedGroups.size ? ` for group(s): ${[...selectedGroups].join(', ')}` : '';
    throw new Error(`No import_enabled spiders found${suffix}`);
  }
  return spiders;
}

function printManifest(manifest) {
  const rows = manifest.spiders || [];
  const groups = rows.reduce((acc, row) => {
    const group = row.group || 'ungrouped';
    if (!acc[group]) acc[group] = { total: 0, enabled: 0 };
    acc[group].total += 1;
    if (row.import_enabled) acc[group].enabled += 1;
    return acc;
  }, {});

  console.log('# ATP Spider Manifest');
  if (manifest.entity) console.log(`entity=${manifest.entity}`);
  if (manifest.source) console.log(`source=${manifest.source}`);
  if (manifest.updated_at) console.log(`updated_at=${manifest.updated_at}`);
  console.log('');
  console.log('## Groups');
  console.log('| group | import_enabled | total |');
  console.log('| --- | ---: | ---: |');
  for (const [group, counts] of Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`| ${group} | ${counts.enabled} | ${counts.total} |`);
  }
  console.log('');
  console.log('## Spiders');
  console.log('| spider | group | status | import_enabled | note |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const row of rows) {
    console.log(`| ${row.spider} | ${row.group || ''} | ${row.status || ''} | ${row.import_enabled ? 'yes' : 'no'} | ${row.note || row.brand || ''} |`);
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  return response.json();
}

async function preflightSpiders(args) {
  const latest = await fetchJson(args.latestUrl);
  const stats = await fetchJson(latest.stats_url);
  const rows = Array.isArray(stats.results) ? stats.results : [];
  const bySpider = new Map(rows.map(row => [row.spider, row]));
  const missing = [];
  const empty = [];
  const warnings = [];

  console.log('# ATP Spider Preflight');
  if (latest.run_id) console.log(`run_id=${latest.run_id}`);
  if (latest.end_time) console.log(`run_ended=${latest.end_time}`);
  console.log('| spider | features | errors | status |');
  console.log('| --- | ---: | ---: | --- |');

  for (const spider of args.spiders) {
    const row = bySpider.get(spider);
    if (!row) {
      missing.push(spider);
      console.log(`| ${spider} | - | - | missing |`);
      continue;
    }

    const features = Number.isFinite(row.features) ? row.features : 0;
    const errors = Number.isFinite(row.errors) ? row.errors : 0;
    if (features <= 0) empty.push(spider);
    if (errors > 0) warnings.push(`${spider} has ${errors} ATP spider errors`);
    console.log(`| ${spider} | ${features} | ${errors} | ${features > 0 ? 'present' : 'empty'} |`);
  }
  console.log('');

  if (warnings.length) {
    console.warn(`Preflight warnings: ${warnings.join('; ')}`);
  }
  if (missing.length || empty.length) {
    const parts = [];
    if (missing.length) parts.push(`missing spiders: ${missing.join(', ')}`);
    if (empty.length) parts.push(`empty spiders: ${empty.join(', ')}`);
    throw new Error(`ATP preflight failed (${parts.join('; ')}). Verify provider spider availability before updating config/atp-pizza-spiders.json.`);
  }
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: options.timeout || 120000,
    ...options,
  }).trim();
}

function featureCount(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(parsed.features) ? parsed.features.length : 0;
}

function reviewQueueImportArgs(args, reviewFiles) {
  const commandArgs = [
    'scripts/ops/import-source-review-queue.mjs',
    '--input-files', reviewFiles.join(','),
    '--entity', args.entity,
  ];
  if (args.applyReviewSchema) commandArgs.push('--apply-schema');
  if (args.applyReviewQueue) commandArgs.push('--apply');
  return commandArgs;
}

async function main() {
  const args = parseArgs(process.argv);
  mkdirSync(resolve(process.cwd(), args.outputDir), { recursive: true });
  mkdirSync(args.downloadDir, { recursive: true });

  if (args.preflight) await preflightSpiders(args);
  if (args.preflightOnly) return;

  const rows = [];
  if (args.useDefaultSpiders) {
    console.log(`# ATP spider manifest: ${args.manifestPath}`);
    console.log('');
  }
  for (const spider of args.spiders) {
    const fileName = `${spider}.geojson`;
    const outputPath = join(args.downloadDir, fileName);
    const reviewPath = join(args.outputDir, `${spider}-review.json`);
    const url = `${args.baseUrl}/${fileName}`;

    console.log(`## ${spider}`);
    console.log(`Downloading ${url}`);
    run('curl', ['-L', '-s', url, '-o', outputPath]);

    if (!existsSync(outputPath)) throw new Error(`Download failed: ${outputPath}`);
    const features = featureCount(outputPath);
    console.log(`features=${features}`);

    const reportArgs = [
      'scripts/ops/source-input-sample-report.mjs',
      '--source', 'all_the_places',
      '--input', outputPath,
      '--entity', args.entity,
      '--scope-config', args.scopeConfig,
      '--limit', String(args.limit),
      '--sample', String(args.sample),
      '--review-output', reviewPath,
    ];
    if (args.apply) reportArgs.push('--apply');

    run(process.execPath, reportArgs, { timeout: 180000 });

    const report = JSON.parse(readFileSync(resolve(process.cwd(), reviewPath), 'utf8'));
    rows.push({
      spider,
      input: report.counts.inputRowsInspected,
      matched: report.counts.matchedExistingPlaces,
      ambiguous: report.counts.ambiguousReviewCandidates,
      likely_new: report.counts.likelyNewUnmatchedCandidates,
      accepted: report.counts.acceptedForPlaceSourcesImport,
      mode: args.apply ? 'apply' : 'dry-run',
      review_file: basename(reviewPath),
      review_path: reviewPath,
    });
  }

  if (args.importReviewQueue && rows.length) {
    console.log('');
    console.log('## Source Review Queue Handoff');
    const reviewFiles = rows.map(row => row.review_path);
    const queueArgs = reviewQueueImportArgs(args, reviewFiles);
    const queueOutput = run(process.execPath, queueArgs, { timeout: 180000 });
    if (queueOutput) console.log(queueOutput);
  }

  console.log('');
  console.log('# ATP Spider Import Summary');
  console.log('| spider | input | matched | ambiguous | likely_new | accepted | mode | review_file |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of rows) {
    console.log(`| ${row.spider} | ${row.input} | ${row.matched} | ${row.ambiguous} | ${row.likely_new} | ${row.accepted} | ${row.mode} | ${row.review_file} |`);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
