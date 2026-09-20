#!/usr/bin/env node
// Read-only, bounded evidence export. No personal ratings, notes or photos.
import pg from 'pg';
import Database from 'better-sqlite3';
import {writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {validClassificationStyle} from '../lib/classification-qa-entity.mjs';
import {isKnownChain,inferStyleFromName} from '../lib/style-inference.mjs';
import {loadRuntimeEnvironment} from '../lib/runtime-environment.mjs';
const args=process.argv.slice(2),output=args[args.indexOf('--output')+1];
if(!args.includes('--output')||!output)throw Error('--output <json-path> is required');
const env=loadRuntimeEnvironment();
const client=new pg.Client({host:env.LOCAL_DB_HOST||env.PGHOST||'localhost',port:Number(env.LOCAL_DB_PORT||env.PGPORT||5432),database:env.LOCAL_DB_NAME||env.PGDATABASE||'pizza_enrichment',user:env.LOCAL_DB_USER||env.PGUSER||process.env.USER,password:env.LOCAL_DB_PASSWORD||env.PGPASSWORD});
const report={generatedAt:new Date().toISOString(),staleAfterHours:24,scope:'Local canonical restaurant records; review candidates, not automatic merge decisions.',sampleLimitPerIssue:150,entities:[],queue:{available:false},errors:[]};
const safeUrl=value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.origin+u.pathname:'';}catch{return '';}};
const columns='p.id,p.name,p.state,p.lat,p.lng,p.google_place_id,p.website_url,p.menu_url,p.enrichment_status,p.last_enriched_at,p.style,p.style_confidence,p.price_range';
await client.connect();
try{
 await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL statement_timeout='120s'");
 for(const entity of ['pizza','taco']){
  const table=entity+'_places';
  const records=(await client.query(`WITH evidence AS (SELECT place_id,count(*) AS source_count,max(retrieved_at) AS evidence_at,coalesce(min(source_url) FILTER (WHERE source='official_website'),min(source_url) FILTER (WHERE source='osm'),min(source_url) FILTER (WHERE source='wikidata'),min(source_url) FILTER (WHERE source_url NOT LIKE '%api_key%' AND source_url NOT LIKE '%token=%')) AS source_url FROM place_sources WHERE entity_type=$1 GROUP BY place_id)
   SELECT ${columns},coalesce(e.source_count,0)::int AS source_count,e.evidence_at,e.source_url FROM ${table} p LEFT JOIN evidence e ON e.place_id=p.id`,[entity])).rows;
  const holdRows=(await client.query('SELECT place_id,reason,evidence,created_at FROM publication_holds WHERE entity_type=$1 AND released_at IS NULL ORDER BY place_id',[entity])).rows;
  const totals={records:records.length},issues={},add=(kind,r,detail,extra={})=>{totals[kind]=(totals[kind]||0)+1;(issues[kind]||=[]);if(issues[kind].length<150)issues[kind].push({...r,detail,...extra,website_url:safeUrl(r.website_url),source_url:safeUrl(r.source_url)});};
  const identity=new Map(),locations=new Map(),byId=new Map(records.map(r=>[String(r.id),r]));
  for(const r of records){
   if(r.google_place_id?.trim()){const a=identity.get(r.google_place_id)||[];a.push(r);identity.set(r.google_place_id,a);}
   const valid=r.lat!==null&&r.lng!==null&&Number.isFinite(r.lat)&&Number.isFinite(r.lng)&&Math.abs(r.lat)<=90&&Math.abs(r.lng)<=180&&!(r.lat===0&&r.lng===0);
   if(!valid)add('coordinates',r,'Missing, out-of-range, or zero/zero coordinates. Verify the restaurant location before moving it.');
   else{const key=r.name.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'')+'|'+r.lat.toFixed(3)+'|'+r.lng.toFixed(3);const a=locations.get(key)||[];a.push(r);locations.set(key,a);}
   if(!r.source_count)add('missing_evidence',r,'No external source record is attached locally. Personal review evidence is not evaluated by this check.');
   if(!r.menu_url?.trim())add('missing_menu',r,'No menu URL recorded. Check the official restaurant website.');
   if(!r.last_enriched_at)add('never_enriched',r,'No successful enrichment timestamp recorded.');
   else if(Date.now()-new Date(r.last_enriched_at).getTime()>90*86400000)add('stale',r,'Last enrichment is more than 90 days old.');
   if(['failed','error'].includes(r.enrichment_status))add('failed',r,'Canonical enrichment status reports a failure.');
   if(!validClassificationStyle(r.style,entity)||(r.price_range&&!['$','$$','$$$','$$$$'].includes(r.price_range)))add('classification',r,'Classification is outside the current product taxonomy. Verify the evidence before changing editorial values.');
   if(entity==='pizza'){const chain=isKnownChain(r.name)?inferStyleFromName(r.name,''):null;if(chain?.style&&r.style&&chain.style!==r.style)add('classification',r,'Style differs from the known chain rule: '+chain.style+'. Review source evidence.');}
   if(r.style&&(!r.style_confidence||['low','uncertain','unknown'].includes(r.style_confidence)))add('classification',r,'A style is recorded without strong confidence. Preserve personal classifications until source evidence is reviewed.');
  }
  for(const group of identity.values())if(group.length>1)for(const r of group)add('duplicate_identity',r,'Multiple canonical rows share this external identity.',{relatedIds:group.filter(x=>x.id!==r.id).map(x=>x.id)});
  for(const group of locations.values())if(group.length>1)for(const r of group)add('possible_duplicate',r,'Same normalized name and coordinates rounded to 0.001°. This is a review candidate, not proof of duplication.',{relatedIds:group.filter(x=>x.id!==r.id).map(x=>x.id)});
  for(const h of holdRows){const r=byId.get(String(h.place_id));if(r)add('publication_hold',r,h.reason.replaceAll('_',' '),{publicId:h.evidence?.public?.id,publicName:h.evidence?.public?.name,holdSince:h.created_at});}
  // Publication holds are small and important: include every one.
  issues.publication_hold=holdRows.map(h=>({...byId.get(String(h.place_id)),id:h.place_id,detail:h.reason.replaceAll('_',' '),publicId:h.evidence?.public?.id,publicName:h.evidence?.public?.name,holdSince:h.created_at,website_url:safeUrl(byId.get(String(h.place_id))?.website_url),source_url:safeUrl(byId.get(String(h.place_id))?.source_url)}));
  report.entities.push({entity,totals,issues});
 }
 await client.query('COMMIT');
}catch(error){await client.query('ROLLBACK');throw error;}finally{await client.end();}
try{
 const q=new Database(env.QUEUE_DB_PATH||resolve('scripts/.job-queue.db'),{readonly:true,fileMustExist:true});
 report.queue={available:true,counts:q.prepare('SELECT place_type,job_type,status,count(*) AS count FROM jobs GROUP BY place_type,job_type,status').all(),failures:q.prepare("SELECT id,place_type,job_type,osm_id,attempts,last_error,completed_at FROM jobs WHERE status='failed' ORDER BY coalesce(completed_at,created_at) DESC LIMIT 150").all().map(r=>({...r,last_error:String(r.last_error||'No detail recorded').replace(/https?:\/\/\S+/g,'[source request]').replace(/(?:key|token|password|secret)\s*[=:]\s*\S+/gi,'[redacted]').slice(0,240)}))};q.close();
}catch(error){report.errors.push({source:'job queue',message:'Queue unavailable; database checks completed.'});}
report.completedAt=new Date().toISOString();mkdirSync(dirname(resolve(output)),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({output,generatedAt:report.generatedAt,entities:report.entities.map(e=>({entity:e.entity,...e.totals})),queueAvailable:report.queue.available}));
