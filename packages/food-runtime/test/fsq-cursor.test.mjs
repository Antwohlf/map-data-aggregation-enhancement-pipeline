import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('FSQ real Python cursor implementation: empty pages, limits, replay, crash, scope and predicates', () => {
  const result = spawnSync(process.env.PYTHON || 'python3', [fileURLToPath(new URL('./fsq-cursor.test.py', import.meta.url)), '-v'], {
    encoding: 'utf8', env: {...process.env, PYTHONDONTWRITEBYTECODE:'1'}, timeout:30000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stderr, /Ran 8 tests/);
});
