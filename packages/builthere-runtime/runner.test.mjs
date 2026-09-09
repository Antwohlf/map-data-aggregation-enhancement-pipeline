import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBuiltHere, postgresContract } from './runner.mjs';
import { parseArguments } from './production.mjs';

async function setup(t) {
  const workspace = await mkdtemp(join(tmpdir(),'builthere-runner-'));
  t.after(() => rm(workspace,{recursive:true,force:true}));
  const calls = []; const seen = new Map(); const events = []; const acquired = [];
  const database = {
    async publishOfficial(commands) { calls.push(structuredClone(commands)); return commands.map(command => { const key = command.metadata.idempotencyKey; if (seen.has(key)) assert.deepEqual(command,seen.get(key)); else seen.set(key,command); return {status:'applied',projectId:`c${seen.size}`}; }); },
    async pendingTips() { return []; }, async publishTips() { return []; },
  };
  return {workspace,database,calls,seen,events,acquired,batchSize:2,maxBatches:1,
    discover:async () => [1,2,3],
    acquire:async (source,ids) => { acquired.push({source,ids}); return {missingIds:[],records:ids.map(id => source === 'detroit' ? {ObjectId:id,record_id:`permit-${id}`,address:'1 Main Street',permit_type:'New',latitude:42,longitude:-83} : {OBJECTID:id,PLANNUMBER:`plan-${id}`,ADDRESS:'1 Main Street',TYPE:'Site plan'})}; },
    compute:async callback => callback(),onEvent:event => events.push(event),
  };
}

test('bounded runs cover every source identity, then begin a new cycle using shared staged execution',async t => {
  const options = await setup(t);
  const first = await runBuiltHere(options);
  assert.equal(first.sources.detroit.cursor,2); assert.equal(first.sources['ann-arbor'].cursor,2);
  const second = await runBuiltHere(options);
  assert.equal(second.sources.detroit.cursor,3); assert.equal(options.seen.size,6);
  assert.deepEqual(options.acquired.map(x => x.ids),[[1,2],[1,2],[3],[3]]);
  assert.deepEqual([...new Set(options.events.map(e => e.kind))],['source','transform','review','output']);
  await runBuiltHere(options); assert.equal(options.seen.size,10);
  const command = options.calls[0][0]; assert.equal(command.metadata.profile,'builthere-city'); assert.equal(command.metadata.sourceNamespace,'detroit'); assert.match(command.metadata.sourceDigest,/^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(command.payload,'verification'),false); assert.equal(Object.hasOwn(command.payload,'city'),false);
});

test('crash after publication replays the exact commands without fetching or changing idempotency',async t => {
  const options = await setup(t); let crash = true;
  await assert.rejects(runBuiltHere({...options,afterPublish:() => { if (crash) { crash=false; throw new Error('synthetic interruption'); } }}),/synthetic interruption/);
  const state = JSON.parse(await readFile(join(options.workspace,'detroit-checkpoint.json')));
  assert.equal(state.cursor,0); assert.equal(state.pending.commands.length,2);
  await runBuiltHere({...options,acquire:async (source,ids) => { assert.notEqual(source,'detroit'); return options.acquire(source,ids); }});
  assert.deepEqual(options.calls[0],options.calls[1]); assert.equal(options.seen.size,4);
});

test('missing identities and invalid rows get durable sanitized outcomes and do not block later IDs',async t => {
  const options = await setup(t);
  options.acquire = async source => ({missingIds:[2],records:[source === 'detroit' ? {ObjectId:1,record_id:'invalid',address:'Address',num_units:1.5} : {OBJECTID:1,PLANNUMBER:'invalid',ADDRESS:null,submitterEmail:'DO_NOT_PERSIST'}]});
  const report = await runBuiltHere(options);
  assert.equal(report.sources.detroit.quarantined,1); assert.equal(report.sources.detroit.missing,1); assert.equal(report.sources.detroit.cursor,2);
  const files = await readdir(join(options.workspace,'reviews'));
  assert.equal(files.length,2);
  for (const file of files) { const content = await readFile(join(options.workspace,'reviews',file),'utf8'); assert.equal(content.includes('DO_NOT_PERSIST'),false); assert.equal(JSON.parse(content).quarantine.length,1); }
});

test('publication failure or invalid receipt does not advance checkpoint',async t => {
  const options = await setup(t); options.database.publishOfficial = async () => [];
  await assert.rejects(runBuiltHere(options),/receipt contract/);
  assert.equal(JSON.parse(await readFile(join(options.workspace,'detroit-checkpoint.json'))).cursor,0);
});

test('approved tip stage passes only stable identity commands, not tip payload or contact fields',async t => {
  const options = await setup(t); let published;
  options.database.pendingTips = async () => [{tip_id:'ctip',payload:{submitterEmail:'DO_NOT_PASS'}}];
  options.database.publishTips = async commands => { published=commands; return [{projectId:'cproject'}]; };
  const result = await runBuiltHere(options);
  assert.equal(result.tips,1); assert.deepEqual(published,[{tipId:'ctip',idempotencyKey:'tip:v1:ctip'}]);
});

test('database adapter isolates only explicit invalid-input errors; infrastructure errors propagate',async () => {
  const calls = [];
  const db = postgresContract({query:async (_query,[encoded]) => { const commands=JSON.parse(encoded); calls.push(commands); if (commands.some(x => x.bad)) throw Object.assign(new Error('secret value'),{code:'22023'}); return {rows:commands.map(() => ({receipt:{status:'applied',projectId:'c1'}}))}; }});
  assert.deepEqual(await db.publishOfficial([{good:true},{bad:true}]),[{status:'applied',projectId:'c1'},{status:'rejected',reason:'database_input_invalid'}]); assert.equal(calls.length,3);
  const broken=postgresContract({query:async () => { throw Object.assign(new Error('network'),{code:'08006'}); }});
  await assert.rejects(broken.publishOfficial([{}]),{code:'08006'});
});

test('production arguments require explicit execution and bounded absolute workspace',() => {
  assert.equal(parseArguments(['--workspace',tmpdir()]).execute,false);
  assert.throws(() => parseArguments(['--workspace','relative','--execute']));
  assert.throws(() => parseArguments(['--workspace',tmpdir(),'--batch-size','251']));
  assert.throws(() => parseArguments(['--workspace',tmpdir(),'--unknown']));
});
