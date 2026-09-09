// BuiltHere source acquisition; no database, private contact fields, or writes.
const SOURCES = Object.freeze({
  detroit: Object.freeze({
    city: 'DETROIT', adapter: 'builthere-detroit-arcgis-v1', objectId: 'ObjectId',
    url: 'https://services2.arcgis.com/qvkbeam7Wirps6zC/arcgis/rest/services/bseed_building_permits/FeatureServer/0',
    fields: ['ObjectId','record_id','address','submitted_date','issued_date','work_description','permit_type','proposed_use_type','use_group','zoning_designation','num_stories','num_units','amt_estimated_contractor_cost','neighborhood','zip_code','latitude','longitude'],
  }),
  'ann-arbor': Object.freeze({
    city: 'ANN_ARBOR', adapter: 'builthere-ann-arbor-arcgis-v1', objectId: 'OBJECTID',
    url: 'https://utility.arcgis.com/usrsvcs/servers/e7a3edceb23b4b97baf2e252acbbd4b8/rest/services/CustomMaps/PlanCases/FeatureServer/0',
    fields: ['OBJECTID','ADDRESS','PLANNUMBER','TYPE','CLASS','STATUS','STREAMURL','COMPLETEYEAR','APPLICATIONYEAR'],
  }),
});

export function arcgisSource(name) {
  if (!Object.hasOwn(SOURCES, name)) throw new Error('Unknown BuiltHere source');
  const source = SOURCES[name];
  return Object.freeze({ ...source, fields: Object.freeze([...source.fields]) });
}

async function query(source, parameters, { fetchImpl = fetch, signal, timeoutMs = 30000, maxBytes = 8 * 1024 * 1024 } = {}) {
  const url = new URL(source.url + '/query');
  // Full 250-ID pages can exceed the provider's URL limit once IDs get longer.
  // ArcGIS query POST is read-only and keeps the bounded page in the form body.
  const body = new URLSearchParams();
  for (const [key,value] of Object.entries({ f:'json', ...parameters })) body.set(key, String(value));
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(url, { method:'POST', body, signal: signal ? AbortSignal.any([signal,timeout]) : timeout, redirect:'error', headers:{Accept:'application/json','content-type':'application/x-www-form-urlencoded'} });
  if (!response.ok) throw new Error(`ArcGIS request failed: HTTP ${response.status}`);
  if (Number(response.headers.get('content-length') || 0) > maxBytes) throw new Error('ArcGIS response exceeds byte limit');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('ArcGIS response has no body');
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const {done,value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error('ArcGIS response exceeds byte limit');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.error) throw new Error('ArcGIS returned an invalid/error response');
  return data;
}

export async function discoverArcgisIds(name, options = {}) {
  const source = arcgisSource(name);
  const data = await query(source, {where:'1=1',returnIdsOnly:true}, options);
  if (data.objectIdFieldName !== source.objectId || !Array.isArray(data.objectIds) || data.objectIds.length > 250000) throw new Error('Unexpected ArcGIS identity contract');
  if (data.objectIds.some(id=>!Number.isSafeInteger(id) || id < 0) || new Set(data.objectIds).size !== data.objectIds.length) throw new Error('Invalid or duplicate ArcGIS object identities');
  return Object.freeze([...data.objectIds].sort((a,b)=>a-b));
}

export async function fetchArcgisRecords(name, ids, options = {}) {
  const source = arcgisSource(name);
  if (!Array.isArray(ids) || !ids.length || ids.length > 250 || ids.some(id=>!Number.isSafeInteger(id) || id<0) || new Set(ids).size !== ids.length) throw new Error('Expected 1–250 distinct ArcGIS identities');
  const data = await query(source, {objectIds:ids.join(','),outFields:source.fields.join(','),returnGeometry:name === 'ann-arbor',outSR:4326,orderByFields:source.objectId+' ASC'}, options);
  if (!Array.isArray(data.features) || data.features.length > ids.length || data.exceededTransferLimit) throw new Error('Incomplete or oversized ArcGIS page');
  const requested = new Set(ids); const seen = new Set();
  const records = data.features.map(feature=>{
    const attributes = feature?.attributes;
    const id = attributes?.[source.objectId];
    if (!requested.has(id) || seen.has(id)) throw new Error('ArcGIS returned an unrequested/duplicate identity');
    seen.add(id);
    // Keep only fields used by the product transform, even if a provider adds extras.
    const result = Object.fromEntries(source.fields.filter(key=>Object.hasOwn(attributes,key)).map(key=>[key,attributes[key]]));
    if (name === 'ann-arbor' && feature.geometry) result.geometry = {x:feature.geometry.x,y:feature.geometry.y};
    return result;
  });
  // Deletions between ID discovery and retrieval are visible, never tombstones.
  return {records,missingIds:ids.filter(id=>!seen.has(id)),source:source.adapter};
}
