import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fsqAcquisitionArguments, fsqAcknowledgementArguments, fsqCursorPath, wikidataAcquisitionArguments } from '../scripts/lib/source-acquisition-arguments.mjs';
import { isWithinScope } from '../scripts/ops/source-input-sample-report.mjs';

const configs = ['source-pipeline.json', 'source-pipeline-taco.json'].map(name => JSON.parse(readFileSync(new URL(`../config/${name}`, import.meta.url), 'utf8')));
const value = (args, flag) => args[args.indexOf(flag) + 1];

test('FSQ filters each product and requested state before a bounded sample is taken', () => {
  for (const config of configs) for (const state of ['MI', 'NY']) {
    const args = fsqAcquisitionArguments({ config, region: { key: state }, output: 'sample.json' });
    assert.equal(value(args, '--entity'), config.entity);
    assert.equal(value(args, '--query'), config.entity);
    assert.equal(value(args, '--region'), state);
    assert.equal(value(args, '--country'), 'US');
    assert.equal(value(args, '--limit'), String(config.limits.candidate_rows_per_source));
    assert.equal(value(args, '--max-files'), String(config.sources.fsq_os_places.max_files));
  }
});

test('Wikidata uses the requested state instead of taking the first nationwide identities', () => {
  const args = wikidataAcquisitionArguments({config:configs[0],region:{key:'MI'},output:'wikidata.json'});
  assert.equal(value(args, '--states'), 'MI');
  assert.throws(() => wikidataAcquisitionArguments({config:configs[1],region:{key:'MI'},output:'taco.json'}), /Pizza-only/);
});

test('Michigan scope rejects known neighboring states within its bounding box for both products', () => {
  for (const config of configs) {
    const scope = {region_scope:'US',regions:config.regions.filter(region=>region.key==='MI')};
    for (const region of ['IL', 'IN', 'OH', 'WI', 'ON']) assert.equal(isWithinScope({lat:42.1,lng:-86.0,region},scope),false,`${config.entity}:${region}`);
    assert.equal(isWithinScope({lat:42.1,lng:-86.0,region:'MI'},scope),true);
    assert.equal(isWithinScope({lat:42.1,lng:-86.0,region:null},scope),true,'preserve incomplete OSM addresses');
    assert.equal(isWithinScope({lat:30,lng:-86.0,region:'MI'},scope),false);
  }
});

test('production source runner uses the scoped argument builders', () => {
  const runner=readFileSync(new URL('../scripts/ops/run-source-pipeline.mjs',import.meta.url),'utf8');
  assert.match(runner,/run\(NODE, wikidataAcquisitionArguments\(/);
  assert.match(runner,/fsqAcquisitionArguments\(\{ region, output, config, cursor \}\)/);
});

test('FSQ cursor isolation, preview and downstream acknowledgement are explicit', () => {
  assert.notEqual(fsqCursorPath('state','pizza','MI'),fsqCursorPath('state','taco','MI'));
  assert.notEqual(fsqCursorPath('state','taco','MI'),fsqCursorPath('state','taco','NY'));
  assert.throws(()=>fsqCursorPath('state','taco','../MI'),/state code/);
  const options={region:{key:'MI'},output:'sample.json',config:configs[1],cursor:'cursor.json'};
  assert(fsqAcquisitionArguments(options).includes('--preview'));
  assert(!fsqAcquisitionArguments({...options,config:{...options.config,apply:true}}).includes('--preview'));
  const ack=fsqAcknowledgementArguments({entity:'taco',region:'MI',cursor:'cursor.json',pageId:'expected'});
  assert.equal(value(ack,'--ack-page'),'expected');
  assert.equal(value(ack,'--region'),'MI');
  const runner=readFileSync(new URL('../scripts/ops/run-source-pipeline.mjs',import.meta.url),'utf8');
  assert.match(runner,/if \(options.apply && paths.fsqDelivery\)/);
  assert(runner.indexOf('processNew(paths.report') < runner.indexOf('fsqAcknowledgementArguments(paths.fsqDelivery)'));
});
