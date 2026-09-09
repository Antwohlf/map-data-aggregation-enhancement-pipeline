import assert from 'node:assert/strict';
import test from 'node:test';
import {arcgisSource,discoverArcgisIds,fetchArcgisRecords} from './arcgis.mjs';
const fake = body => async () => new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});

test('source IDs are fixed, bounded, sorted and validated before paging',async()=>{
  assert.throws(()=>arcgisSource('custom-url'),/Unknown/);
  assert.deepEqual(await discoverArcgisIds('detroit',{fetchImpl:fake({objectIdFieldName:'ObjectId',objectIds:[3,1,2]})}),[1,2,3]);
  await assert.rejects(discoverArcgisIds('detroit',{fetchImpl:fake({objectIdFieldName:'OBJECTID',objectIds:[1]})}),/identity/);
  await assert.rejects(discoverArcgisIds('detroit',{fetchImpl:fake({objectIdFieldName:'ObjectId',objectIds:[1,1]})}),/duplicate/);
});

test('pages use exact IDs and a field allowlist; missing records never become deletions',async()=>{
  let requested;
  const page = await fetchArcgisRecords('ann-arbor',[1,2],{fetchImpl:async (url,options)=>{
    assert.equal(options.method,'POST');
    assert.equal(url.search,'');
    requested=options.body;
    return new Response(JSON.stringify({features:[{attributes:{OBJECTID:1,PLANNUMBER:'synthetic-plan',ADDRESS:'123 Example Street',submitterEmail:'not-retained'},geometry:{x:-83,y:42,z:5}}]}));
  }});
  assert.equal(requested.get('objectIds'),'1,2');
  assert.equal(requested.get('outSR'),'4326');
  assert.equal(requested.get('orderByFields'),'OBJECTID ASC');
  assert(!requested.get('outFields').includes('*'));
  assert.deepEqual(page.missingIds,[2]);
  assert.equal(page.records[0].submitterEmail,undefined);
  assert.deepEqual(page.records[0].geometry,{x:-83,y:42});
});

test('full pages of long object IDs never overflow the request URL',async()=>{
  const ids=Array.from({length:250},(_,i)=>1000000+i);
  await fetchArcgisRecords('detroit',ids,{fetchImpl:async(url,options)=>{
    assert(url.href.length<500);
    assert.equal(options.method,'POST');
    assert.deepEqual(options.body.get('objectIds').split(',').map(Number),ids);
    return new Response(JSON.stringify({features:[]}));
  }});
});

test('provider errors, transfer truncation, identity injection and oversized bodies fail closed',async()=>{
  for(const response of [{error:{code:500}},{features:[],exceededTransferLimit:true},{features:[{attributes:{ObjectId:999}}]}]) {
    await assert.rejects(fetchArcgisRecords('detroit',[1],{fetchImpl:fake(response)}));
  }
  await assert.rejects(fetchArcgisRecords('detroit',[1],{fetchImpl:fake({features:[],padding:'x'.repeat(100)}),maxBytes:20}),/byte limit/);
  await assert.rejects(fetchArcgisRecords('detroit',Array.from({length:251},(_,i)=>i),{fetchImpl:fake({})}),/1–250/);
});
