import { assertSourcePipelineEntity } from './source-pipeline-entity.mjs';

// Apply product/geography predicates before the export limit. Filtering a
// truncated nationwide, all-business sample later can starve a whole product.
export function fsqAcquisitionArguments({ region, output, config }) {
  const entity = assertSourcePipelineEntity(config.entity);
  return ['scripts/ops/export-fsq-hf-parquet-sample.py',
    '--entity', entity, '--query', entity, '--country', 'US', '--region', region.key,
    '--max-files', String(config.sources.fsq_os_places.max_files),
    '--limit', String(config.limits.candidate_rows_per_source), '--output', output];
}

export function wikidataAcquisitionArguments({ region, output, config }) {
  if (config.entity !== 'pizza') throw new Error('Wikidata acquisition is Pizza-only');
  return ['scripts/ops/export-wikidata-source.mjs', '--output', output,
    '--states', region.key, '--limit', String(config.sources.wikidata.rows_per_run || 50)];
}
