import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {sourcePipelineOvertureOutputPath} from '../scripts/lib/source-pipeline-entity.mjs';
import {prepareOvertureDelivery,commitOvertureDelivery} from '../scripts/lib/overture-delivery.mjs';

test('actual plan command resumes incomplete Taco scans hourly and paces completed scans weekly',t=>{
  const root=mkdtempSync(join(tmpdir(),'taco-cadence-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const config=JSON.parse(readFileSync(new URL('../config/source-pipeline-taco.json',import.meta.url)));
  config.regions=[config.regions[0]];config.sources={overture_places:config.sources.overture_places};
  const configPath=join(root,'config.json'),statePath=join(root,'state.json');
  writeFileSync(configPath,JSON.stringify(config));
  writeFileSync(statePath,JSON.stringify({sources:{overture_places:{last_success:new Date(Date.now()-2*3600000).toISOString()}},region_index:0}));
  const plan=()=>{
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/ops/run-source-pipeline.mjs',import.meta.url)),'--plan','--source','overture_places','--json'],{cwd:root,encoding:'utf8',env:{...process.env,SOURCE_PIPELINE_CONFIG:configPath,SOURCE_PIPELINE_STATE:statePath}});
    assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
  };
  assert.equal(plan().work_units.length,1);
  const output=sourcePipelineOvertureOutputPath(root,'MI','taco');mkdirSync(dirname(output),{recursive:true});
  const manifestPath=`${output}.manifest.json`,checkpoint=`${output}.delivery.json`;
  writeFileSync(manifestPath,JSON.stringify({version:2,entity:'taco',adapter_id:'food-source-overture-taco-v1',category_policy:'overture-taco-taxonomy-v1',release:'2026-08-19.0',bbox:config.regions[0].bbox,step:1,pagination:'id-keyset-v1',total_tiles:1,rows:0,tiles:{one:{status:'success',rows:[]}}}));
  commitOvertureDelivery(prepareOvertureDelivery({output,manifestPath,checkpoint,input:join(root,'page.json'),entity:'taco',categoryPolicy:'overture-taco-taxonomy-v1',limit:2500,acquire:()=>{}}));
  assert.equal(plan().work_units.length,0);assert.equal(plan().skipped[0].cadence_hours,168);
});
