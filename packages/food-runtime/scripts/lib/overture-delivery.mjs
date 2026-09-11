import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const read = path => JSON.parse(readFileSync(path,'utf8'));
function save(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary,'wx',0o600);
  try { writeFileSync(fd,JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary,path);
  const dir = openSync(dirname(path),'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
}
function identity(manifest, entity, categoryPolicy) {
  if (manifest?.version !== 2 || manifest.entity !== entity || manifest.category_policy !== categoryPolicy || manifest.adapter_id !== `food-source-overture-${entity === 'taco' ? 'taco-' : ''}v1`) throw new Error('Overture delivery identity mismatch');
  return hash([manifest.version,entity,categoryPolicy,manifest.release,manifest.bbox,manifest.step,manifest.pagination]);
}
function stateFor(path, id) {
  if (!existsSync(path)) return {version:1,identity:id,offset:0,prefix:hash([]),pending:null};
  const state = read(path);
  if (state.version !== 1 || !Number.isSafeInteger(state.offset) || state.offset < 0 || !/^[a-f0-9]{64}$/.test(state.prefix)) throw new Error('Invalid Overture delivery checkpoint');
  if (state.identity !== id) {
    if (state.pending || !state.complete) throw new Error('Undelivered Overture release cannot be replaced');
    return {version:1,identity:id,offset:0,prefix:hash([]),pending:null};
  }
  return state;
}
function complete(manifest) {
  return Number.isSafeInteger(manifest.total_tiles) && manifest.total_tiles > 0 &&
    Object.values(manifest.tiles).filter(tile => tile.status === 'success').length === manifest.total_tiles;
}

function manifestRows(manifest) {
  // The exporter commits each tile to the manifest before replacing its
  // cumulative output. Reconstruct from that durability boundary after crashes.
  const rows = new Map();
  for (const tile of Object.values(manifest.tiles)) {
    if (!Array.isArray(tile.rows)) throw new Error('Missing durable Overture tile rows');
    for (const row of tile.rows) {
      if (typeof row.id !== 'string' || !row.id || row.overture_release !== manifest.release || row.overture_adapter !== manifest.adapter_id || row.overture_category_policy !== manifest.category_policy) throw new Error('Overture row provenance mismatch');
      rows.set(row.id,row);
    }
  }
  return [...rows.values()];
}

// A bounded delivery page survives acquisition/review failures. Commit only
// after matching, queue import, and the existing guarded output have succeeded.
export function prepareOvertureDelivery({ output, manifestPath, checkpoint, input, entity, categoryPolicy, limit, acquire }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error('Invalid Overture delivery limit');
  let manifest = existsSync(manifestPath) ? read(manifestPath) : null;
  let state = manifest ? stateFor(checkpoint,identity(manifest,entity,categoryPolicy)) : null;
  let rows = manifest ? manifestRows(manifest) : [];
  if (!Array.isArray(rows)) throw new Error('Invalid Overture rows');
  if (state && hash(rows.slice(0,state.offset)) !== state.prefix) throw new Error('Overture delivered prefix changed');
  if (!state?.pending && (!manifest || rows.length === state.offset)) {
    // Even empty pages are acknowledged before allowing the next acquisition.
    acquire();
    manifest = read(manifestPath);
    state = stateFor(checkpoint,identity(manifest,entity,categoryPolicy));
    rows = manifestRows(manifest);
  }
  if (!Array.isArray(rows) || rows.length < state.offset || hash(rows.slice(0,state.offset)) !== state.prefix) throw new Error('Overture output no longer matches delivery checkpoint');
  if (!state.pending) {
    const end = Math.min(state.offset+limit,rows.length);
    state.pending = {start:state.offset,end,rows:rows.slice(state.offset,end),prefix:hash(rows.slice(0,end)),complete:complete(manifest) && end === rows.length};
    save(checkpoint,state);
  }
  const token = hash(state.pending);
  save(input,state.pending.rows);
  return {input,checkpoint,identity:state.identity,token,rows:state.pending.rows.length};
}

export function commitOvertureDelivery(delivery) {
  const state = read(delivery.checkpoint);
  if (state.identity !== delivery.identity || !state.pending || hash(state.pending) !== delivery.token) throw new Error('Overture delivery acknowledgement mismatch');
  const {end,prefix,complete} = state.pending;
  save(delivery.checkpoint,{version:1,identity:state.identity,offset:end,prefix,complete,pending:null});
}

export function overtureHasBacklog({manifestPath,checkpoint,entity,categoryPolicy}) {
  if (!existsSync(manifestPath)) return true;
  const manifest = read(manifestPath);
  const state = stateFor(checkpoint,identity(manifest,entity,categoryPolicy));
  return !complete(manifest) || Boolean(state.pending) || state.offset < manifest.rows;
}
