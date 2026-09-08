import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, mkdirSync, rmSync, symlinkSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { codeRoot, planTask, prepareWorkspace, validateWorkspace } from '../production.mjs';

test('product profiles pin entity, source configuration, and distinct checkpoints', () => {
  const workspace = join(tmpdir(), 'synthetic-food-workspace');
  const env = { APIZZA_SYNC_ENTITY: 'wrong', SOURCE_PIPELINE_CONFIG: 'wrong', SOURCE_PIPELINE_STATE: 'wrong', APIZZA_SYNC_CHECKPOINT: 'wrong', APIZZA_SYNC_STATUS_FILE: 'wrong', APIZZA_SYNC_RECONCILE_CHECKPOINT: 'wrong' };
  const pizza = planTask({ profile: 'apizzamichigan', task: 'source', workspace }, env);
  const taco = planTask({ profile: 'tacoboutmichigan', task: 'source', workspace }, env);
  assert.equal(pizza.env.APIZZA_SYNC_ENTITY, 'pizza');
  assert.equal(taco.env.APIZZA_SYNC_ENTITY, 'taco');
  assert.notEqual(pizza.env.SOURCE_PIPELINE_CONFIG, taco.env.SOURCE_PIPELINE_CONFIG);
  assert.notEqual(pizza.env.SOURCE_PIPELINE_STATE, taco.env.SOURCE_PIPELINE_STATE);
  for (const key of ['APIZZA_SYNC_CHECKPOINT', 'APIZZA_SYNC_STATUS_FILE', 'APIZZA_SYNC_RECONCILE_CHECKPOINT']) {
    assert.notEqual(pizza.env[key], taco.env[key]);
    assert.ok(pizza.env[key].startsWith(workspace));
    assert.ok(taco.env[key].startsWith(workspace));
  }
  assert.ok(pizza.args.includes('--apply'));
  assert.equal(pizza.cwd, workspace);
  assert.ok(pizza.args[0].startsWith(codeRoot));
  assert.notEqual(pizza.env, env);
});

test('unknown tasks/profiles and product-scoped shared workers are rejected', () => {
  for (const [profile, task] of [['unknown', 'source'], ['apizzamichigan', 'classify'], ['food-shared', 'source'], ['food-shared', 'toString']]) {
    assert.throws(() => planTask({ profile, task, workspace: tmpdir() }, {}));
  }
  const shared = planTask({ profile: 'food-shared', task: 'classify', workspace: tmpdir() }, { APIZZA_SYNC_ENTITY: 'pizza' });
  assert.equal(shared.env.APIZZA_SYNC_ENTITY, undefined);
});

test('workspace preparation isolates code, is idempotent, and preserves private files', t => {
  const workspace = mkdtempSync(join(tmpdir(), 'food-workspace-test-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  chmodSync(workspace, 0o700);
  writeFileSync(join(workspace, '.env'), 'SYNTHETIC=true', { mode: 0o600 });
  const first = prepareWorkspace(workspace);
  assert.ok(first.linkedFiles > 60);
  assert.deepEqual(prepareWorkspace(workspace), first);
  assert.equal(readlinkSync(join(workspace, 'scripts/enrichment/queue.mjs')), join(codeRoot, 'scripts/enrichment/queue.mjs'));
  chmodSync(workspace, 0o755);
  assert.throws(() => validateWorkspace(workspace), /0700/);
});

test('preparation refuses existing files and redirected directories', t => {
  const workspace = mkdtempSync(join(tmpdir(), 'food-workspace-conflict-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  mkdirSync(join(workspace, 'config'));
  writeFileSync(join(workspace, 'config/entity-profiles.json'), '{}');
  assert.throws(() => prepareWorkspace(workspace), /Refusing to replace/);
  rmSync(join(workspace, 'config'), { recursive: true });
  symlinkSync(join(codeRoot, 'config'), join(workspace, 'config'));
  assert.throws(() => prepareWorkspace(workspace), /Refusing to replace|cannot be a symlink/);
  assert.throws(() => validateWorkspace(codeRoot), /separate/);
});

test('CLI plans do not start jobs and execution refuses staged or empty queues', t => {
  const workspace = mkdtempSync(join(tmpdir(), 'food-workspace-gate-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  prepareWorkspace(workspace);
  const args = [join(codeRoot, 'production.mjs'), '--profile', 'apizzamichigan', '--task', 'source', '--workspace', workspace];
  const plan = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(JSON.parse(plan.stdout).execute, false);
  const empty = spawnSync(process.execPath, [...args, '--execute'], { encoding: 'utf8' });
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /Existing food queue is required/);
  writeFileSync(join(workspace, 'STAGING-NOT-ACTIVE.json'), '{}');
  const staged = spawnSync(process.execPath, [...args, '--execute'], { encoding: 'utf8' });
  assert.equal(staged.status, 1);
  assert.match(staged.stderr, /staged only/);
});

test('supervisor escalates shutdown for a non-cooperative child and grandchild', { skip: process.platform === 'win32', timeout: 7000 }, async t => {
  const grandchild = "process.on('SIGTERM',()=>{}); console.log('grandchild-ready'); setInterval(()=>{},1000)";
  const child = `const {spawn}=require('node:child_process'); process.on('SIGTERM',()=>{}); spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'inherit'}); setInterval(()=>{},1000)`;
  const moduleUrl = pathToFileURL(join(codeRoot, 'production.mjs')).href;
  const harness = `import {superviseTask} from ${JSON.stringify(moduleUrl)}; const child=superviseTask({command:process.execPath,args:['-e',${JSON.stringify(child)}],cwd:process.cwd(),env:process.env},{graceMs:100}); console.log('group='+child.pid)`;
  const wrapper = spawn(process.execPath, ['--input-type=module', '-e', harness], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let group;
  let stopped = false;
  t.after(() => {
    wrapper.kill('SIGKILL');
    if (group) { try { process.kill(-group, 'SIGKILL'); } catch {} }
  });
  const closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Supervisor failed to drain descendant stdout')), 5000);
    wrapper.once('error', reject);
    wrapper.once('close', code => { clearTimeout(timer); resolve(code); });
  });
  wrapper.stdout.on('data', chunk => {
    output += chunk.toString();
    group = Number(output.match(/group=(\d+)/)?.[1]) || group;
    if (!stopped && output.includes('grandchild-ready')) {
      stopped = true;
      wrapper.kill('SIGTERM');
    }
  });
  assert.equal(await closed, 1);
  assert.equal(stopped, true);
});
