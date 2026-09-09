import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadTaskEnvironment, filterTaskEnvironment } from '../task-environment.mjs';

function fixture(t) {
  const workspace = mkdtempSync(join(tmpdir(), 'task-env-'));
  mkdirSync(join(workspace, 'secrets'), { mode: 0o700 });
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  return { workspace, write: (name, value) => writeFileSync(join(workspace, name), value, { mode: 0o600 }) };
}

test('publication credentials reach only publication; unrelated secrets reach no task', () => {
  const env = { 'SUPABASE_SERVICE_ROLE_KEY': '<synthetic-publish>', VITE_SUPABASE_URL: 'https://example.test', HF_TOKEN: '<synthetic-source>', ADMIN_PASSWORD: '<synthetic-admin>', GITHUB_TOKEN: '<synthetic-git>', 'PGPASSWORD': '<synthetic-db>', PATH: '/usr/bin' };
  for (const task of ['source', 'publish', 'classify', 'scrape', 'feed-classifier', 'backup']) {
    const selected = filterTaskEnvironment(env, task);
    assert.equal(selected.SUPABASE_SERVICE_ROLE_KEY, task === 'publish' ? env.SUPABASE_SERVICE_ROLE_KEY : undefined);
    assert.equal(selected.HF_TOKEN, task === 'source' ? env.HF_TOKEN : undefined);
    assert.equal(selected.ADMIN_PASSWORD, undefined);
    assert.equal(selected.GITHUB_TOKEN, undefined);
    assert.equal(selected.PGPASSWORD, env.PGPASSWORD);
    assert.equal(selected.PATH, env.PATH);
  }
});

test('task credential files are scoped and inherited explicit settings win', t => {
  const f = fixture(t);
  f.write('.env', 'PGUSER=shared\n');
  f.write('.env.local', 'PGUSER=local\n');
  f.write('secrets/publication.env', 'SUPABASE_SERVICE_ROLE_KEY=<synthetic-publication>\n');
  f.write('secrets/apizzamichigan.publish.env', 'PGUSER=pizza-publisher\n');
  f.write('secrets/tacoboutmichigan.publish.env', 'PGUSER=taco-publisher\n');
  for (const [profile, user] of [['apizzamichigan', 'pizza-publisher'], ['tacoboutmichigan', 'taco-publisher']]) {
    const options = { workspace: f.workspace, profile, task: 'publish' };
    assert.equal(loadTaskEnvironment(options, {}).PGUSER, user);
    assert.equal(loadTaskEnvironment(options, { PGUSER: 'scheduler' }).PGUSER, 'scheduler');
  }
  assert.equal(loadTaskEnvironment({ workspace: f.workspace, profile: 'food-shared', task: 'classify' }, {}).SUPABASE_SERVICE_ROLE_KEY, undefined);
  assert.throws(() => loadTaskEnvironment({ workspace: f.workspace, profile: '../outside', task: 'publish' }, {}), /scope/);
});

test('nonpublishers never open publication secrets; unsafe env files fail closed', t => {
  const f = fixture(t);
  f.write('secrets/publication.env', 'SUPABASE_SERVICE_ROLE_KEY=<synthetic>\n');
  chmodSync(join(f.workspace, 'secrets/publication.env'), 0o644);
  const shared = { workspace: f.workspace, profile: 'food-shared', task: 'backup' };
  assert.deepEqual(loadTaskEnvironment(shared, {}), {});
  assert.throws(() => loadTaskEnvironment({ ...shared, profile: 'apizzamichigan', task: 'publish' }, {}), /must be a private/);
  symlinkSync(join(f.workspace, 'secrets/publication.env'), join(f.workspace, '.env'));
  assert.throws(() => loadTaskEnvironment(shared, {}));
});
