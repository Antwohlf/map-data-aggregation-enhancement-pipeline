import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadRuntimeEnvironment } from './runtime-environment.mjs';

test('runtime environment uses dotenv parsing and explicit inherited overrides', t => {
  const root = mkdtempSync(join(tmpdir(), 'food-runtime-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, '.env'), 'ORDER=base\nBASE_ONLY="two words"\n');
  writeFileSync(join(root, '.env.local'), 'ORDER=local\nLOCAL_ONLY=present # comment\n');

  const env = loadRuntimeEnvironment({ root, inherited: { ORDER: 'job', JOB_ONLY: 'explicit' } });
  assert.deepEqual(env, { ORDER: 'job', BASE_ONLY: 'two words', LOCAL_ONLY: 'present', JOB_ONLY: 'explicit' });
});

test('missing files return a copy without logging', t => {
  const root = mkdtempSync(join(tmpdir(), 'food-runtime-env-missing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = t.mock.method(console, 'log');
  const warn = t.mock.method(console, 'warn');
  const error = t.mock.method(console, 'error');
  const inherited = { SAFE: 'value' };

  const env = loadRuntimeEnvironment({ root, inherited });
  assert.deepEqual(env, inherited);
  assert.notEqual(env, inherited);
  assert.equal(log.mock.callCount() + warn.mock.callCount() + error.mock.callCount(), 0);
});
