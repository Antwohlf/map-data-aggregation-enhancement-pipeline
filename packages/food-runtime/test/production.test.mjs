import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, mkdirSync, rmSync, symlinkSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { codeRoot, planTask, prepareWorkspace, validateWorkspace } from '../production.mjs';

test('product profiles pin entity, source configuration, and distinct checkpoints', () => {
  const workspace = join(tmpdir(), 'synthetic-food-workspace');
  const env = { APIZZA_SYNC_ENTITY: 'wrong', SOURCE_PIPELINE_CONFIG: 'wrong', SOURCE_PIPELINE_STATE: 'wrong' };
  const pizza = planTask({ profile: 'apizzamichigan', task: 'source', workspace }, env);
  const taco = planTask({ profile: 'tacoboutmichigan', task: 'source', workspace }, env);
  assert.equal(pizza.env.APIZZA_SYNC_ENTITY, 'pizza');
  assert.equal(taco.env.APIZZA_SYNC_ENTITY, 'taco');
  assert.notEqual(pizza.env.SOURCE_PIPELINE_CONFIG, taco.env.SOURCE_PIPELINE_CONFIG);
  assert.notEqual(pizza.env.SOURCE_PIPELINE_STATE, taco.env.SOURCE_PIPELINE_STATE);
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
