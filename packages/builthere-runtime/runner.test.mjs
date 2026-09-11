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
    async storageBytes() { return 10_000_000; },
    async publishOfficial(commands) { calls.push(structuredClone(commands)); return commands.map(command => { const key = command.metadata.idempotencyKey; if (seen.has(key)) assert.deepEqual(command,seen.get(key)); else seen.set(key,command); return {status:'applied',projectId:`c${seen.size}`}; }); },
    async pendingTips() { return []; }, async publishTips() { return []; },
  };
  return {workspace,database,calls,seen,events,acquired,batchSize:2,maxBatches:1,
    now: () => new Date(Date.now() + 2 * 86400000),
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
  await runBuiltHere({...options,now:()=>new Date(Date.now()+4*86400000)}); assert.equal(options.seen.size,6);
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

test('daily cadence avoids reacquisition; later scans skip unchanged versions without audit growth',async t => {
  const options = await setup(t); options.maxBatches=2;
  await runBuiltHere(options);
  const acquired=options.acquired.length;
  const files=await readdir(join(options.workspace,'reviews'));
  const second=await runBuiltHere(options);
  assert.equal(second.sources.detroit.reason,'refresh_cadence');
  assert.equal(options.acquired.length,acquired);
  const refreshed=await runBuiltHere({...options,now:()=>new Date(Date.now()+4*86400000)});
  assert.equal(refreshed.sources.detroit.unchanged,3);
  assert.equal(options.seen.size,6);
  assert.deepEqual(await readdir(join(options.workspace,'reviews')),files);
});

test('A to B to A remains deliverable, including two ObjectIDs sharing a source identity in one page',async t => {
  const options=await setup(t); options.maxBatches=2;
  options.discover=async source=>source==='detroit'?[2]:[];
  options.acquire=async()=>({missingIds:[],records:[{ObjectId:2,record_id:'shared',address:'A'}]});
  await runBuiltHere(options);
  options.discover=async source=>source==='detroit'?[1,2]:[];
  options.acquire=async()=>({missingIds:[],records:[{ObjectId:1,record_id:'shared',address:'B'},{ObjectId:2,record_id:'shared',address:'A'}]});
  await runBuiltHere({...options,now:()=>new Date(Date.now()+4*86400000)});
  assert.deepEqual(options.calls.at(-1).map(c=>c.payload.address),['B','A']);
  const result=await runBuiltHere({...options,now:()=>new Date(Date.now()+6*86400000)});
  assert.equal(result.sources.detroit.published,2);
});

test('committed pending commands recover at the database limit; new acquisitions remain stopped',async t => {
  const options=await setup(t); let bytes=10000;
  options.database.storageBytes=async()=>bytes;
  await assert.rejects(runBuiltHere({...options,afterPublish:()=>{bytes=450000000;throw new Error('crash');}}),/crash/);
  await assert.rejects(runBuiltHere(options),{code:'BUILTHERE_STORAGE_BUDGET'}); // next source stops
  assert.deepEqual(options.calls[0],options.calls[1]);
  assert.equal(JSON.parse(await readFile(join(options.workspace,'detroit-checkpoint.json'))).cursor,2);
});

test('unknown/full database or insufficient workspace budget stops before publication',async t => {
  const options=await setup(t);
  await assert.rejects(runBuiltHere({...options,policy:{workspaceMaxBytes:1500}}),{code:'BUILTHERE_WORKSPACE_BUDGET'});
  assert.equal(options.calls.length,0);
  options.database.storageBytes=async()=>NaN;
  await assert.rejects(runBuiltHere(options),/Invalid database storage measurement/);
  options.database.storageBytes=async()=>450000000;
  await assert.rejects(runBuiltHere(options),{code:'BUILTHERE_STORAGE_BUDGET'});
  assert.equal(options.calls.length,0);
});
