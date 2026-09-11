import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareOvertureDelivery,commitOvertureDelivery,overtureHasBacklog} from './overture-delivery.mjs';

function setup(t) {
  const root=mkdtempSync(join(tmpdir(),'overture-delivery-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const options={output:join(root,'rows.json'),manifestPath:join(root,'manifest.json'),checkpoint:join(root,'delivery.json'),input:join(root,'page.json'),entity:'taco',categoryPolicy:'overture-taco-taxonomy-v1',limit:2500};
  const manifest={version:2,entity:'taco',category_policy:options.categoryPolicy,adapter_id:'food-source-overture-taco-v1',release:'2026-08-19.0',bbox:[1,2,3,4],step:1,pagination:'id-keyset-v1',total_tiles:2,tiles:{a:{status:'success'}},rows:2501};
  const rows=Array.from({length:2501},(_,i)=>({id:`taco-${i}`,overture_release:manifest.release,overture_adapter:manifest.adapter_id,overture_category_policy:manifest.category_policy}));
  const save=()=>{manifest.tiles.a.rows=rows; if(manifest.tiles.b)manifest.tiles.b.rows=[];writeFileSync(options.output,JSON.stringify(rows));writeFileSync(options.manifestPath,JSON.stringify(manifest));};save();
  return {options,manifest,rows,save};
}
test('every page reaches review; failure retries exact page before advancing acquisition',t=>{
  const {options}=setup(t);let acquired=0;options.acquire=()=>acquired++;
  const first=prepareOvertureDelivery(options);const data=readFileSync(options.input,'utf8');
  assert.equal(first.rows,2500); assert.equal(acquired,0);
  const retry=prepareOvertureDelivery(options);assert.equal(retry.token,first.token);assert.equal(readFileSync(options.input,'utf8'),data);
  commitOvertureDelivery(retry);
  const second=prepareOvertureDelivery(options);assert.equal(second.rows,1);assert.equal(JSON.parse(readFileSync(options.input))[0].id,'taco-2500');
  assert.equal(acquired,0);commitOvertureDelivery(second);
  assert.equal(overtureHasBacklog(options),true);
  prepareOvertureDelivery(options);assert.equal(acquired,1);
});
test('completed release waits for refresh and can advance only after all delivery acknowledgements',t=>{
  const {options,manifest,rows,save}=setup(t);manifest.tiles.b={status:'success'};save();options.acquire=()=>assert.fail('unexpected acquire');
  commitOvertureDelivery(prepareOvertureDelivery(options));
  assert.equal(overtureHasBacklog(options),true);
  commitOvertureDelivery(prepareOvertureDelivery(options));
  assert.equal(overtureHasBacklog(options),false);
  options.acquire=()=>{manifest.release='2026-09-16.0';for(const row of rows)row.overture_release=manifest.release;save();};
  const next=prepareOvertureDelivery(options);assert.equal(next.rows,2500);
});
test('cross-product manifests, changed prefixes and foreign acknowledgements fail closed',t=>{
  const {options,manifest,rows,save}=setup(t);
  assert.throws(()=>prepareOvertureDelivery({...options,entity:'pizza'}),/identity mismatch/);
  const first=prepareOvertureDelivery(options);
  assert.throws(()=>commitOvertureDelivery({...first,token:'foreign'}),/acknowledgement mismatch/);
  manifest.release='2026-09-16.0';save();
  assert.throws(()=>prepareOvertureDelivery(options),/Undelivered/);
  manifest.release='2026-08-19.0';save();commitOvertureDelivery(first);
  rows[0].id='foreign';save();assert.throws(()=>prepareOvertureDelivery(options),/prefix changed/);
});

test('crash between new-release manifest and output writes delivers only durable new-release rows',t=>{
  const {options,manifest,rows,save}=setup(t);manifest.tiles.b={status:'success'};save();
  commitOvertureDelivery(prepareOvertureDelivery(options));
  commitOvertureDelivery(prepareOvertureDelivery(options));
  const oldOutput=readFileSync(options.output,'utf8');
  manifest.release='2026-09-16.0';
  rows.splice(0,rows.length,{id:'new-release-taco',overture_release:manifest.release,overture_adapter:manifest.adapter_id,overture_category_policy:manifest.category_policy});
  manifest.rows=1;save();writeFileSync(options.output,oldOutput);
  options.acquire=()=>assert.fail('manifest already contains an undelivered page');
  const delivery=prepareOvertureDelivery(options);
  assert.equal(delivery.rows,1);
  assert.equal(JSON.parse(readFileSync(options.input))[0].overture_release,manifest.release);
  commitOvertureDelivery(delivery);assert.equal(overtureHasBacklog(options),false);
});
