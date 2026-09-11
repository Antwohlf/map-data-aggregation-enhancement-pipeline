import { assertSourcePipelineEntity } from './source-pipeline-entity.mjs';
import { join } from 'node:path';

export function fsqCursorPath(root, entity, region) {
  assertSourcePipelineEntity(entity);
  if (!/^[A-Z]{2}$/.test(region)) throw new Error('FSQ requires an exact state code');
  return join(root, 'scripts/.source-cursors', `fsq-${entity}-${region}.json`);
}

// Apply product/geography predicates before the export limit. Filtering a
// truncated nationwide, all-business sample later can starve a whole product.
export function fsqAcquisitionArguments({ region, output, config, cursor }) {
  const entity = assertSourcePipelineEntity(config.entity);
  return ['scripts/ops/export-fsq-hf-parquet-sample.py',
    '--entity', entity, '--query', entity, '--country', 'US', '--region', region.key,
    '--max-files', String(config.sources.fsq_os_places.max_files),
    '--max-scan-rows', String(config.sources.fsq_os_places.max_scan_rows || 1250000),
    '--refresh-hours', String(config.sources.fsq_os_places.cadence_hours),
    '--limit', String(config.limits.candidate_rows_per_source), '--output', output,
    ...(cursor ? ['--cursor', cursor, ...(!config.apply ? ['--preview'] : [])] : [])];
}

export function fsqAcknowledgementArguments(delivery) {
  return ['scripts/ops/export-fsq-hf-parquet-sample.py', '--entity', delivery.entity,
    '--query', delivery.entity, '--country', 'US', '--region', delivery.region,
    '--cursor', delivery.cursor, '--ack-page', delivery.pageId];
}

export function wikidataAcquisitionArguments({ region, output, config }) {
  if (config.entity !== 'pizza') throw new Error('Wikidata acquisition is Pizza-only');
  return ['scripts/ops/export-wikidata-source.mjs', '--output', output,
    '--states', region.key, '--limit', String(config.sources.wikidata.rows_per_run || 50)];
}
