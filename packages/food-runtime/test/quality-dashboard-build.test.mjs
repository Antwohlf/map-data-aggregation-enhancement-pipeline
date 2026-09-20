import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {Script} from 'node:vm';
test('standalone report safely embeds hostile restaurant text and literal replacement tokens',()=>{
 const dir=mkdtempSync(join(tmpdir(),'quality-build-'));
 try{
  const data={generatedAt:'2026-09-20T00:00:00Z',entities:[{name:'Pizza $& </script><script>throw Error("injected")</script>'}]};
  writeFileSync(join(dir,'input.json'),JSON.stringify(data));
  execFileSync(process.execPath,[fileURLToPath(new URL('../scripts/ops/build-restaurant-quality-dashboard.mjs',import.meta.url)),'--input',join(dir,'input.json'),'--output',join(dir,'out')]);
  const html=readFileSync(join(dir,'out/index.html'),'utf8');
  const scripts=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length,2,'Only embedded data and dashboard code may become scripts');
  assert.deepEqual(JSON.parse(scripts[0][1]),data);
  assert.doesNotThrow(()=>new Script(scripts[1][1]));
  assert.ok(!html.includes('<script src="dashboard.js">'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
