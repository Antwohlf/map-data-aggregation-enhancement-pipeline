import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import test from 'node:test';
import { fsqAcquisitionArguments, fsqAcknowledgementArguments, fsqCursorPath } from '../scripts/lib/source-acquisition-arguments.mjs';

const runner = readFileSync(new URL('../scripts/ops/run-source-pipeline.mjs', import.meta.url), 'utf8');
const config = JSON.parse(readFileSync(new URL('../config/source-pipeline-taco.json', import.meta.url), 'utf8'));
const value = (args, flag) => args[args.indexOf(flag) + 1];

test('FSQ preview is read-only and apply enables durable cursor pages', () => {
  const options = { region: { key: 'MI' }, output: '/tmp/fsq.json', config, cursor: '/tmp/fsq-taco-mi.json' };
  const preview = fsqAcquisitionArguments(options);
  assert(preview.includes('--preview'));
  assert.equal(value(preview, '--cursor'), options.cursor);
  const apply = fsqAcquisitionArguments({ ...options, config: { ...config, apply: true } });
  assert(!apply.includes('--preview'));
  assert.equal(value(apply, '--max-scan-rows'), String(config.sources.fsq_os_places.max_scan_rows));
});

test('FSQ cursor and ack are entity/state bound', () => {
  assert.notEqual(fsqCursorPath('state', 'pizza', 'MI'), fsqCursorPath('state', 'taco', 'MI'));
  assert.notEqual(fsqCursorPath('state', 'taco', 'MI'), fsqCursorPath('state', 'taco', 'NY'));
  const ack = fsqAcknowledgementArguments({ entity: 'taco', region: 'MI', cursor: '/tmp/cursor', pageId: 'a'.repeat(64) });
  assert.equal(value(ack, '--ack-page'), 'a'.repeat(64));
  assert.equal(value(ack, '--region'), 'MI');
});

test('source runner preserves pending pages through downstream work and acknowledges only on apply', () => {
  assert.match(runner, /const page = loadJson\(`\$\{output\}\.page\.json`/);
  assert.match(runner, /if \(options\.apply && paths\.fsqDelivery\)/);
  assert(runner.indexOf('processNew(paths.report') < runner.indexOf('fsqAcknowledgementArguments(paths.fsqDelivery)'));
  assert.match(runner, /resume_cadence_hours/);
  assert.match(runner, /!cursor\?\.complete \|\| Boolean\(cursor\.pending\)/);
  assert.match(runner, /if \(source === 'fsq_os_places'\)/);
});

test('source runner uses a stable product/state cursor rather than timestamped cursor paths', () => {
  assert.match(runner, /fsqCursorPath\(ROOT, config\.entity, region\.key\)/);
  assert.doesNotMatch(runner, /fsq-\$\{now\}/);
});

test('real Python metadata/download safety tests run in the normal npm suite', () => {
  const result=spawnSync(process.env.PYTHON||'python3',[fileURLToPath(new URL('./fsq-acquisition-safety.test.py',import.meta.url))],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},timeout:30000});
  assert.equal(result.status,0,result.stderr||result.error?.message);
  assert.match(result.stderr,/Ran 4 tests/);
});

test('actual source plan resumes incomplete FSQ scans hourly and paces completed scans',t=>{
  const root=mkdtempSync(join(tmpdir(),'fsq-cadence-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const configPath=join(root,'config.json'),statePath=join(root,'state.json');
  writeFileSync(configPath,JSON.stringify({...config,operational_regions:['MI'],regions:config.regions.filter(r=>r.key==='MI')}));
  writeFileSync(statePath,JSON.stringify({sources:{fsq_os_places:{last_success:new Date(Date.now()-2*3600000).toISOString()}}}));
  const cursor=fsqCursorPath(root,'taco','MI');mkdirSync(dirname(cursor),{recursive:true});
  function plan(state){
    writeFileSync(cursor,JSON.stringify(state));
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/ops/run-source-pipeline.mjs',import.meta.url)),'--plan','--source','fsq_os_places','--json'],{cwd:root,encoding:'utf8',env:{...process.env,SOURCE_PIPELINE_CONFIG:configPath,SOURCE_PIPELINE_STATE:statePath},timeout:30000});
    assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
  }
  assert.equal(plan({complete:false,pending:null}).work_units[0].cadence_hours,1);
  assert.equal(plan({complete:true,pending:{page_id:'pending'}}).work_units[0].cadence_hours,1);
  assert(plan({complete:true,pending:null}).skipped.some(item=>item.source==='fsq_os_places'&&item.reason==='cadence_not_due'));
});
