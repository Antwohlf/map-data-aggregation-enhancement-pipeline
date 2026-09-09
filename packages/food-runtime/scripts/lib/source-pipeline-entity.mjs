import { resolve } from 'node:path';

const ENTITY_CANDIDATE_TERMS = Object.freeze({
  pizza: Object.freeze([
    'apizza',
    'flatbread',
    'italian restaurant',
    'pizza',
    'pizzeria',
    'slice',
    'wood fired',
    'wood-fired',
  ]),
  taco: Object.freeze([
    'burrito',
    'mexican',
    'taco',
    'taqueria',
    'tex mex',
  ]),
});

export function assertSourcePipelineEntity(entity) {
  if (!Object.hasOwn(ENTITY_CANDIDATE_TERMS, entity)) {
    throw new Error(`Unsupported source pipeline entity: ${entity || '(missing)'}`);
  }
  return entity;
}

export function defaultSourcePipelineConfigPath(entity) {
  return assertSourcePipelineEntity(entity) === 'taco'
    ? 'config/source-pipeline-taco.json'
    : 'config/source-pipeline.json';
}

export function sourcePipelineOsmOutputPath(root, regionKey, entity) {
  const supportedEntity = assertSourcePipelineEntity(entity);
  return resolve(root, 'reports/osm', `${String(regionKey).toLowerCase()}-${supportedEntity}.json`);
}

export function sourcePipelineOvertureOutputPath(root, regionKey, entity) {
  const supportedEntity = assertSourcePipelineEntity(entity);
  return resolve(root, 'data/source-inputs', `overture_places-${String(regionKey).toLowerCase()}-${supportedEntity}-v2.json`);
}

export function sourcePipelineReviewOutputPath(root, source, regionKey, entity) {
  const supportedEntity = assertSourcePipelineEntity(entity);
  const fileName = supportedEntity === 'pizza'
    ? `${source}-${regionKey}-review.json`
    : `${source}-${regionKey}-${supportedEntity}-review.json`;
  return resolve(root, 'reports/source-review', fileName);
}

export function isSourceCandidateForEntity(candidate, entity) {
  const supportedEntity = assertSourcePipelineEntity(entity);
  const categories = Array.isArray(candidate?.categories)
    ? candidate.categories.join(' ')
    : String(candidate?.categories || '');
  const haystack = normalizeText([
    candidate?.name,
    categories,
    candidate?.website,
    candidate?.source_url,
  ].join(' '));
  return ENTITY_CANDIDATE_TERMS[supportedEntity].some(term => haystack.includes(term));
}

export function sourceInputSampleReportArguments({
  source,
  input,
  entity,
  scopeConfig,
  limit,
  reviewOutput,
  apply = false,
}) {
  const supportedEntity = assertSourcePipelineEntity(entity);
  if (!scopeConfig) throw new Error('Missing source pipeline scope config path');
  return [
    'scripts/ops/source-input-sample-report.mjs',
    '--source', source,
    '--input', input,
    '--entity', supportedEntity,
    '--scope-config', scopeConfig,
    '--max-distance-m', '100',
    '--limit', String(limit),
    '--sample', '10',
    '--review-output', reviewOutput,
    ...(apply ? ['--apply'] : []),
  ];
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
