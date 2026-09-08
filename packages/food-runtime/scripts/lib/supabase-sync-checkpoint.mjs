import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export function readSyncCheckpoint(path) {
  if (!path || !existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (
    !parsed?.last_enriched_at ||
    Number.isNaN(Date.parse(parsed.last_enriched_at)) ||
    !Number.isFinite(Number(parsed.id))
  ) {
    throw new Error(`Invalid sync checkpoint: ${path}`);
  }
  return {
    lastEnrichedAt: parsed.last_enriched_at,
    id: Number(parsed.id),
    source: path,
  };
}

export function readIdCheckpoint(path) {
  if (!path || !existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Number.isFinite(Number(parsed?.last_id))) {
    throw new Error(`Invalid ID sync checkpoint: ${path}`);
  }
  return {
    lastId: Number(parsed.last_id),
    source: path,
  };
}

export function checkpointFromRow(row) {
  if (!row?.last_enriched_at || !Number.isFinite(Number(row.id))) return null;
  const preciseLastEnrichedAt = row.sync_checkpoint_last_enriched_at || row.last_enriched_at;
  return {
    last_enriched_at: typeof preciseLastEnrichedAt === 'string'
      ? preciseLastEnrichedAt
      : new Date(preciseLastEnrichedAt).toISOString(),
    id: Number(row.id),
    saved_at: new Date().toISOString(),
  };
}

export function idCheckpointFromRow(row) {
  if (!Number.isFinite(Number(row?.id))) return null;
  return {
    mode: 'id',
    last_id: Number(row.id),
    saved_at: new Date().toISOString(),
  };
}

export function writeSyncCheckpoint(path, checkpoint) {
  if (!path || !checkpoint) return;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(checkpoint, null, 2)}\n`);
  renameSync(tmp, path);
}
