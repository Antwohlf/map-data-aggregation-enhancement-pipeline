import test from 'node:test';
import assert from 'node:assert/strict';
import { readPublicationHolds } from './publication-holds.mjs';
import { allocateNextCanonicalPlaceId, PIPELINE_ID_MIN, PIPELINE_ID_MAX } from './canonical-place-id.mjs';
import { localSyncSelect } from './supabase-sync-policy.mjs';

test('held explicit records are refused and missing registry fails closed', async () => {
  const client = { query: async () => ({ rows: [{ place_id: '12', reason: 'ambiguous_identity' }] }) };
  await assert.rejects(readPublicationHolds(client, 'pizza', [12]), /held for review/);
  assert.deepEqual((await readPublicationHolds(client, 'pizza')).ids, ['12']);
  await assert.rejects(readPublicationHolds({ query: async () => { throw Error('registry unavailable'); } }, 'pizza'), /unavailable/);
});

test('holds apply to cursor, reconcile and lifecycle selections without SQL interpolation', () => {
  for (const options of [{}, {reconcile:true}, {checkpointMode:true}, {ids:[12],lifecycleOnly:true}]) {
    const selection = localSyncSelect({...options,entity:'pizza',publicationHoldIds:['12','45']});
    assert.match(selection.sql, /id <> ALL\(\$\d+::bigint\[\]\)/);
    assert.ok(selection.params.some(p => Array.isArray(p) && p.join(',') === '12,45'));
  }
});

test('allocator locks before allocation and rejects unsafe ranges and identifiers', async () => {
  const calls=[];
  const client={query:async sql=>{calls.push(sql);return {rows:[{next_id:String(PIPELINE_ID_MIN)}]};}};
  assert.equal(await allocateNextCanonicalPlaceId(client,'pizza_places'),PIPELINE_ID_MIN);
  assert.equal(calls[0],'LOCK TABLE pizza_places IN EXCLUSIVE MODE');
  assert.match(calls[1], /GREATEST/);
  for (const next_id of [PIPELINE_ID_MIN-1,PIPELINE_ID_MAX+1,NaN]) {
    await assert.rejects(allocateNextCanonicalPlaceId({query:async()=>({rows:[{next_id}]})},'taco_places'),/range exhausted or invalid/);
  }
  await assert.rejects(allocateNextCanonicalPlaceId(client,'pizza_places; DROP TABLE x'),/Unsupported/);
});
