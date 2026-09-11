import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { executeTrustedHostStagesAsync } from '@map-pipeline/executor/trusted-host';
import { withHostCompute, withHostResource } from '@map-pipeline/executor/host-resource-gate';
import { discoverArcgisIds, fetchArcgisRecords, arcgisSource } from './arcgis.mjs';
import { commandVersion, VERSION_LEDGER_VERSION, storagePolicy, assertDatabaseBudget, assertWorkspaceBudget } from './storage.mjs';
import { mapDetroitPermit, mapAnnArborPlanCase } from './transforms.mjs';

const SOURCES = ['detroit', 'ann-arbor'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = value => JSON.parse(JSON.stringify(value));
function validBusiness(value) {
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 500 || typeof value.address !== 'string' || !value.address.trim()) return false;
  for (const field of ['description','neighborhood','zipCode','sourceUrl','permitType','zoningDesignation','addressHash']) if (value[field] != null && typeof value[field] !== 'string') return false;
  for (const field of ['latitude','longitude','estimatedCost']) if (value[field] != null && (typeof value[field] !== 'number' || !Number.isFinite(value[field]))) return false;
  if (value.latitude != null && Math.abs(value.latitude) > 90 || value.longitude != null && Math.abs(value.longitude) > 180) return false;
  for (const field of ['numUnits','numStories']) if (value[field] != null && (!Number.isInteger(value[field]) || value[field] < -2147483648 || value[field] > 2147483647)) return false;
  for (const field of ['submittedDate','approvedDate','completedDate']) if (value[field] != null && (!(value[field] instanceof Date) || !Number.isFinite(value[field].getTime()))) return false;
  return ['HOUSING','FOOD','RETAIL','OFFICE','INFRA','OTHER'].includes(value.category) && ['MINOR','MODERATE','MAJOR'].includes(value.scale) && ['PROPOSED','APPROVED','UNDER_CONSTRUCTION','COMPLETED','CANCELLED'].includes(value.phase);
}
function bounded(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError(`Invalid ${label}`);
  return value;
}
async function save(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  try { await rename(temporary, path); } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  const directory = await open(dirname(path),'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
async function load(path, source) {
  let state;
  try { state = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (state.schemaVersion !== 1 || state.source !== source || typeof state.cycle !== 'string' || !Array.isArray(state.ids) || state.ids.some(id => !Number.isSafeInteger(id) || id < 0) || new Set(state.ids).size !== state.ids.length || !Number.isSafeInteger(state.cursor) || state.cursor < 0 || state.cursor > state.ids.length) throw new Error('Invalid BuiltHere checkpoint');
  if (state.pending && (state.pending.start !== state.cursor || !Number.isSafeInteger(state.pending.end) || state.pending.end <= state.cursor || state.pending.end > state.ids.length || !Array.isArray(state.pending.commands) || !Array.isArray(state.pending.quarantine) || !Array.isArray(state.pending.missingIds))) throw new Error('Invalid BuiltHere pending batch');
  if (state.versions !== undefined && (!state.versions || Array.isArray(state.versions) || typeof state.versions !== 'object' || Object.values(state.versions).some(v => !/^[a-f0-9]{64}$/.test(v)))) throw new Error('Invalid BuiltHere version ledger');
  if (state.completedAt !== undefined && !Number.isFinite(Date.parse(state.completedAt))) throw new Error('Invalid BuiltHere completion time');
  state.versions ??= {};
  if (state.versionLedgerVersion !== VERSION_LEDGER_VERSION && (state.versionLedgerVersion !== undefined || Object.keys(state.versions).length)) throw Object.assign(new Error('BuiltHere version ledger migration required'),{code:'BUILTHERE_LEDGER_MIGRATION_REQUIRED'});
  state.versionLedgerVersion = VERSION_LEDGER_VERSION;
  return state;
}

export function officialDefinition(source) {
  const sourceAdapter = arcgisSource(source).adapter;
  return { id: `builthere-${source}-v1`, schemaVersion: 1, stages: [
    {id:'acquire',kind:'source',adapter:sourceAdapter,version:1,dependsOn:[],config:{}},
    {id:'transform',kind:'transform',adapter:`builthere-${source}-transform-v1`,version:1,dependsOn:['acquire'],config:{}},
    {id:'review',kind:'review',adapter:'builthere-official-review-v1',version:1,dependsOn:['transform'],config:{}},
    {id:'publish',kind:'output',adapter:'builthere-project-contract-v1',version:1,dependsOn:['review'],config:{}},
  ]};
}

// Only acquisition uses the shared compute slot. Database publication does not
// block another product's local model or source processing.
export async function runBuiltHere({ workspace, database, batchSize = 100, maxBatches = 4, tipLimit = 100, env = process.env, signal, discover = discoverArcgisIds, acquire = fetchArcgisRecords, compute = withHostCompute, onEvent, afterPublish, policy: policyInput, now = () => new Date() } = {}) {
  if (!isAbsolute(workspace || '')) throw new TypeError('BuiltHere workspace must be absolute');
  const policy = storagePolicy(policyInput);
  bounded(batchSize,250,'batch size'); bounded(maxBatches,1000,'batch count'); bounded(tipLimit,1000,'tip limit');
  if (!database || typeof database.publishOfficial !== 'function' || typeof database.pendingTips !== 'function' || typeof database.publishTips !== 'function' || typeof database.storageBytes !== 'function') throw new TypeError('Missing BuiltHere database contract');
  await mkdir(workspace, {recursive:true,mode:0o700});
  await mkdir(join(workspace,'reviews'),{recursive:true,mode:0o700});
  return withHostResource({root:workspace,resource:'builthere-run',signal,waitTimeoutMs:0}, async () => {
    const summary = {schemaVersion:1, sources:{},tips:0};
    const budget = async count => {
      await assertWorkspaceBudget(workspace,policy);
      assertDatabaseBudget(await database.storageBytes(),count,policy);
    };
    const saveBounded = async (path,value) => {
      await assertWorkspaceBudget(workspace,policy,Buffer.byteLength(JSON.stringify(value))*2+4096);
      await save(path,value);
    };
    for (const source of SOURCES) {
      const path = join(workspace, `${source}-checkpoint.json`);
      let state = await load(path, source);
      if (state?.completedAt && now().getTime() - Date.parse(state.completedAt) < policy.refreshHours * 3600000) {
        summary.sources[source] = {deferred:true,reason:'refresh_cadence',completedAt:state.completedAt};
        continue;
      }
      if (!state?.pending) await budget(0);
      if (!state || state.cursor === state.ids.length) {
        const ids = await compute(() => discover(source,{signal}),{env,signal});
        state = {schemaVersion:1,source,cycle:randomUUID(),ids:[...ids],cursor:0,pending:null,versions:state?.versions ?? {},versionLedgerVersion:VERSION_LEDGER_VERSION};
        if (!ids.length) state.completedAt = now().toISOString();
        await saveBounded(path,state);
      }
      const totals = {unchanged:0,published:0,created:0,changed:0,quarantined:0,missing:0,batches:0,cursor:state.cursor,total:state.ids.length};
      for (let batch = 0; batch < maxBatches && state.cursor < state.ids.length; batch++) {
        signal?.throwIfAborted();
        const replaying = Boolean(state.pending);
        if (!replaying) await budget(0);
        const end = state.pending?.end ?? Math.min(state.cursor+batchSize,state.ids.length);
        const definition = officialDefinition(source);
        const registry = [
          {id:definition.stages[0].adapter,version:1,kind:'source',run:() => state.pending ? null : compute(() => acquire(source,state.ids.slice(state.cursor,end),{signal}),{env,signal})},
          {id:definition.stages[1].adapter,version:1,kind:'transform',run:({inputs}) => {
            if (state.pending) return state.pending;
            const commands = []; const quarantine = []; let unchanged = 0; const stagedVersions = {...state.versions};
            for (const raw of inputs.acquire.records) {
              const objectId = raw[arcgisSource(source).objectId];
              let mapped;
              try { mapped = (source === 'detroit' ? mapDetroitPermit : mapAnnArborPlanCase)(raw); } catch { quarantine.push({objectId,reason:'transform_invalid'}); continue; }
              if (!mapped || typeof mapped.sourceId !== 'string' || !mapped.sourceId.trim()) { quarantine.push({objectId,reason:'identity_missing'}); continue; }
              const {city,sourceType,sourceId,verification,...business} = mapped;
              if (!validBusiness(business)) { quarantine.push({objectId,reason:'mapped_contract_invalid'}); continue; }
              const payload = json(business);
              const observationId = `${state.cycle}:${objectId}`;
              const observedAt = new Date().toISOString();
              const command = {sourceType:source,sourceId,metadata:{contractVersion:1,transformVersion:1,profile:'builthere-city',sourceNamespace:source,policyVersion:1,observationId,idempotencyKey:`official:${source}:${observationId}`,sourceDigest:digest(raw),mappedDigest:digest(payload),retrievedAt:observedAt,observedAt},payload};
              if (Object.hasOwn(stagedVersions, sourceId) && stagedVersions[sourceId] === commandVersion(command)) unchanged++;
              else commands.push(command);
              Object.defineProperty(stagedVersions,sourceId,{value:commandVersion(command),enumerable:true,writable:true,configurable:true});
            }
            return {start:state.cursor,end,commands,quarantine,unchanged,missingIds:inputs.acquire.missingIds};
          }},
          {id:'builthere-official-review-v1',version:1,kind:'review',run:async ({inputs}) => {
            // The SQL contract is the final authority on types and ownership;
            // stage artifacts contain no submitter names, emails or raw tips.
            const pending = inputs.transform;
            if (!state.pending) { state.pending = pending; await saveBounded(path,state); }
            return pending;
          }},
          {id:'builthere-project-contract-v1',version:1,kind:'output',run:async ({inputs}) => {
            const pending = inputs.review;
            // Existing pending commands may already be committed. Let the SQL
            // replay check answer first; the database trigger blocks any NEW write.
            if (pending.commands.length && !replaying) await budget(pending.commands.length);
            await assertWorkspaceBudget(workspace,policy,Buffer.byteLength(JSON.stringify(state))*3 + pending.commands.length*policy.reservePerCommandBytes + 16384);
            const receipts = pending.commands.length ? await database.publishOfficial(pending.commands) : [];
            if (!Array.isArray(receipts) || receipts.length !== pending.commands.length || receipts.some(receipt => !receipt || !['applied','rejected'].includes(receipt.status) || receipt.status === 'applied' && typeof receipt.projectId !== 'string' || receipt.status === 'rejected' && receipt.reason !== 'database_input_invalid')) throw new Error('BuiltHere publication receipt contract failed');
            const rejected = receipts.flatMap((receipt,index) => receipt.status === 'rejected' ? [{observationId:pending.commands[index].metadata.observationId,reason:'database_input_invalid'}] : []);
            await afterPublish?.({source,pending});
            // Preserve review outcomes durably before advancing the source cursor.
            if (pending.commands.length || pending.quarantine.length || pending.missingIds.length) await saveBounded(join(workspace,'reviews',`${source}-${state.cycle}-${pending.start}.json`),{cycle:state.cycle,start:pending.start,end:pending.end,quarantine:[...pending.quarantine,...rejected],missingIds:pending.missingIds,commands:pending.commands,receipts});
            receipts.forEach((receipt,index) => { if (receipt.status === 'applied') {
              const command = pending.commands[index];
              Object.defineProperty(state.versions,command.sourceId,{value:commandVersion(command),enumerable:true,writable:true,configurable:true});
            }});
            if (pending.end === state.ids.length) state.completedAt = now().toISOString();
            state.cursor = pending.end; state.pending = null; await saveBounded(path,state);
            return {unchanged:pending.unchanged ?? 0,published:receipts.length-rejected.length,created:receipts.filter(r=>r.created===true).length,changed:receipts.filter(r=>r.changed===true).length,quarantined:pending.quarantine.length+rejected.length,missing:pending.missingIds.length};
          }},
        ];
        const result = await executeTrustedHostStagesAsync({definition,registry,onEvent});
        for (const key of ['unchanged','published','created','changed','quarantined','missing']) totals[key] += result.outputs.publish[key];
        totals.batches++; totals.cursor = state.cursor;
      }
      summary.sources[source] = totals;
    }
    const tipDefinition = {id:'builthere-community-v1',schemaVersion:1,stages:[
      {id:'acquire',kind:'source',adapter:'builthere-approved-tip-outbox-v1',version:1,dependsOn:[],config:{}},
      {id:'transform',kind:'transform',adapter:'builthere-tip-command-v1',version:1,dependsOn:['acquire'],config:{}},
      {id:'review',kind:'review',adapter:'builthere-tip-approval-v1',version:1,dependsOn:['transform'],config:{}},
      {id:'publish',kind:'output',adapter:'builthere-community-contract-v1',version:1,dependsOn:['review'],config:{}},
    ]};
    const tipRuns = [
      () => database.pendingTips(tipLimit),
      ({inputs}) => inputs.acquire.map(row => { if (typeof row.tip_id !== 'string' || !row.tip_id) throw new Error('Invalid approved tip identity'); return {tipId:row.tip_id,idempotencyKey:`tip:v1:${row.tip_id}`}; }),
      ({inputs}) => inputs.transform,
      async ({inputs}) => { if (inputs.review.length) await budget(inputs.review.length); const receipts = inputs.review.length ? await database.publishTips(inputs.review) : []; if (!Array.isArray(receipts) || receipts.length !== inputs.review.length || receipts.some(r => !r?.projectId)) throw new Error('Invalid community publication receipts'); return receipts.length; },
    ];
    const tips = await executeTrustedHostStagesAsync({definition:tipDefinition,registry:tipDefinition.stages.map((stage,index) => ({id:stage.adapter,kind:stage.kind,version:1,run:tipRuns[index]})),onEvent});
    summary.tips = tips.outputs.publish;
    await saveBounded(join(workspace,'last-run.json'),{...summary,completedAt:new Date().toISOString()});
    return summary;
  });
}

export function postgresContract(client) {
  async function publish(functionName,commands) {
    const result = await client.query(`SELECT builthere_pipeline.${functionName}(value) AS receipt FROM jsonb_array_elements($1::jsonb)`,[JSON.stringify(commands)]);
    return result.rows.map(row => row.receipt);
  }
  return {
    storageBytes: async () => Number((await client.query('SELECT pg_database_size(current_database())::text AS bytes')).rows[0].bytes),
    publishOfficial: async commands => {
      try { return await publish('apply_official_v1',commands); }
      catch (error) { if (error.code !== '22023') throw error; }
      // The failed batch statement rolled back atomically. Isolate explicitly
      // invalid input; never classify transport, authority or conflicts as data.
      const receipts = [];
      for (const command of commands) {
        try { receipts.push(...await publish('apply_official_v1',[command])); }
        catch (error) { if (error.code !== '22023') throw error; receipts.push({status:'rejected',reason:'database_input_invalid'}); }
      }
      return receipts;
    },
    pendingTips: async limit => (await client.query('SELECT tip_id FROM builthere_pipeline.pending_tips_v1 ORDER BY tip_id LIMIT $1',[limit])).rows,
    publishTips: commands => publish('publish_tip_v1',commands),
  };
}
