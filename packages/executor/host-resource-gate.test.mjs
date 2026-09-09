import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { withHostResource } from './host-resource-gate.mjs';

const moduleUrl = new URL('./host-resource-gate.mjs', import.meta.url).href;
const childProgram = `
  import { appendFile } from 'node:fs/promises';
  const [moduleUrl, root, resource, id, holdMs, logPath, crash] = process.argv.slice(1);
  const { withHostResource } = await import(moduleUrl);
  await withHostResource({ root, resource, pollMs: 5 }, async () => {
    await appendFile(logPath, 'enter ' + id + '\\n');
    process.stdout.write('entered\\n');
    if (crash === 'yes') await new Promise(() => { setInterval(() => {}, 1_000); });
    if (holdMs === 'release') {
      process.stdin.resume();
      await new Promise(resolve => process.stdin.once('end', resolve));
    } else await new Promise(resolve => setTimeout(resolve, Number(holdMs)));
    await appendFile(logPath, 'exit ' + id + '\\n');
  });
`;

function runChild(root, resource, id, holdMs, logPath, crash = 'no') {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childProgram, moduleUrl, root, resource, id, String(holdMs), logPath, crash], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', value => { stdout += value; });
  child.stderr.on('data', value => { stderr += value; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done, release: () => child.stdin.end(), entered: () => waitFor(() => stdout.includes('entered')) };
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('test condition timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function ticketCount(root, resource) {
  const path = join(root, '.host-resource-gates', resource, 'waiters');
  try {
    return (await readdir(path)).filter(name => name.endsWith('.wait')).length;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

test('serializes cooperating processes in FIFO order', async t => {
  const root = await mkdtemp(join(tmpdir(), 'host-resource-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = join(root, 'events.log');
  const first = runChild(root, 'heavy-source', 'first', 'release', logPath);
  t.after(() => first.child.kill('SIGKILL'));
  await first.entered();
  const second = runChild(root, 'heavy-source', 'second', 30, logPath);
  await waitFor(async () => (await ticketCount(root, 'heavy-source')) === 2);
  const third = runChild(root, 'heavy-source', 'third', 10, logPath);
  await waitFor(async () => (await ticketCount(root, 'heavy-source')) === 3);
  first.release();
  const outcomes = await Promise.all([first.done, second.done, third.done]);
  assert.deepEqual(outcomes.map(value => value.code), [0, 0, 0], outcomes.map(value => value.stderr).join('\n'));
  assert.deepEqual((await readFile(logPath, 'utf8')).trim().split('\n'), ['enter first', 'exit first', 'enter second', 'exit second', 'enter third', 'exit third']);
});

test('queued abort and timeout remove their tickets without releasing the holder', async t => {
  const root = await mkdtemp(join(tmpdir(), 'host-resource-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let release;
  const holder = withHostResource({ root, resource: 'ollama', pollMs: 5 }, () => new Promise(resolve => { release = resolve; }));
  await waitFor(() => typeof release === 'function');
  const controller = new AbortController();
  const aborted = withHostResource({ root, resource: 'ollama', signal: controller.signal, pollMs: 5 }, async () => assert.fail('aborted callback ran'));
  await waitFor(async () => (await ticketCount(root, 'ollama')) === 2);
  controller.abort(new Error('cancelled'));
  await assert.rejects(aborted, /cancelled/);
  await assert.rejects(withHostResource({ root, resource: 'ollama', waitTimeoutMs: 30, pollMs: 5 }, async () => assert.fail('timed-out callback ran')), /timed out/);
  assert.equal(await ticketCount(root, 'ollama'), 1);
  release('held-result');
  assert.equal(await holder, 'held-result');
  assert.equal(await ticketCount(root, 'ollama'), 0);
});

test('callback failures release the lease for a later invocation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'host-resource-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(withHostResource({ root, resource: 'ollama' }, async () => { throw new Error('adapter failed'); }), /adapter failed/);
  assert.equal(await withHostResource({ root, resource: 'ollama', waitTimeoutMs: 100 }, async () => 'recovered'), 'recovered');
});

test('a later process safely discards a dead queued waiter', async t => {
  const root = await mkdtemp(join(tmpdir(), 'host-resource-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = join(root, 'events.log');
  const holder = runChild(root, 'heavy-source', 'holder', 'release', logPath);
  t.after(() => holder.child.kill('SIGKILL'));
  await holder.entered();
  const deadWaiter = runChild(root, 'heavy-source', 'dead-waiter', 0, logPath);
  await waitFor(async () => (await ticketCount(root, 'heavy-source')) === 2);
  deadWaiter.child.kill('SIGKILL');
  await deadWaiter.done;
  const follower = runChild(root, 'heavy-source', 'follower', 0, logPath);
  await waitFor(async () => (await ticketCount(root, 'heavy-source')) === 2);
  holder.release();
  const outcomes = await Promise.all([holder.done, follower.done]);
  assert.deepEqual(outcomes.map(value => value.code), [0, 0], outcomes.map(value => value.stderr).join('\n'));
  assert.deepEqual((await readFile(logPath, 'utf8')).trim().split('\n'), ['enter holder', 'exit holder', 'enter follower', 'exit follower']);
});

test('never steals a lease from a crashed owner process', async t => {
  const root = await mkdtemp(join(tmpdir(), 'host-resource-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = join(root, 'events.log');
  const owner = runChild(root, 'heavy-source', 'owner', 0, logPath, 'yes');
  await owner.entered();
  owner.child.kill('SIGKILL');
  await owner.done;
  await assert.rejects(withHostResource({ root, resource: 'heavy-source', waitTimeoutMs: 40, pollMs: 5 }, async () => assert.fail('stale lease was stolen')), /timed out/);
  assert.equal(await ticketCount(root, 'heavy-source'), 1);
});

test('dead detached owner is recovered only after its entire process group exits', async t => {
  if (process.platform === 'win32') return t.skip('POSIX process groups');
  const root = await mkdtemp(join(tmpdir(), 'host-resource-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const program = `
    import { spawn } from 'node:child_process';
    const { withHostResource } = await import(${JSON.stringify(moduleUrl)});
    await withHostResource({ root: ${JSON.stringify(root)}, resource: 'compute' }, async () => {
      spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      process.stdout.write('held');
      await new Promise(() => setInterval(()=>{},1000));
    });
  `;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', program], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const done = new Promise(resolve => owner.once('exit', resolve));
  t.after(() => { try { process.kill(-owner.pid, 'SIGKILL'); } catch {} });
  await new Promise(resolve => owner.stdout.once('data', resolve));
  owner.kill('SIGTERM');
  await done;
  await assert.rejects(withHostResource({ root, resource: 'compute', waitTimeoutMs: 40, pollMs: 5 }, () => assert.fail('live grandchild was ignored')), /timed out/);
  process.kill(-owner.pid, 'SIGKILL');
  assert.equal(await withHostResource({ root, resource: 'compute', waitTimeoutMs: 3000, pollMs: 10 }, () => 'recovered'), 'recovered');
});
