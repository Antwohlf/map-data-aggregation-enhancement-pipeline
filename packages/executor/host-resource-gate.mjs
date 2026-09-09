import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const RESOURCE = /^[a-z][a-z0-9-]{0,63}$/;

function fail(message) {
  throw new TypeError(message);
}

function validate({ root, resource, signal, waitTimeoutMs, pollMs }, callback) {
  if (typeof root !== 'string' || !isAbsolute(root)) fail('root must be an absolute path');
  if (typeof resource !== 'string' || !RESOURCE.test(resource)) fail('resource must be a safe lowercase resource name');
  if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) fail('signal must be an AbortSignal');
  if (waitTimeoutMs !== undefined && (!Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs < 0)) fail('waitTimeoutMs must be a non-negative safe integer');
  if (pollMs !== undefined && (!Number.isSafeInteger(pollMs) || pollMs < 1)) fail('pollMs must be a positive safe integer');
  if (typeof callback !== 'function') fail('callback must be a function');
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('resource wait aborted');
  error.name = 'AbortError';
  return error;
}

async function sleep(ms, signal) {
  if (signal?.aborted) throw abortError(signal);
  await new Promise((resolveWait, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolveWait();
    }
    function aborted() {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      reject(abortError(signal));
    }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

async function missing(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readOwner(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`resource gate contains a non-regular owner record: ${path}`);
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw error;
    throw new Error(`resource gate contains an unreadable owner record: ${path}`, { cause: error });
  }
  if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.token !== 'string' || !value.token) {
    throw new Error(`resource gate contains an invalid owner record: ${path}`);
  }
  return { info, value };
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

function processGroupId() {
  if (process.platform === 'win32') return null;
  const value = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('cannot establish resource owner process group');
  return value;
}

async function recoverDeadLease(leasePath) {
  let owner;
  try { owner = await readOwner(leasePath); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  const pgid = owner.value.pgid;
  if (processIsAlive(owner.value.pid) || !Number.isSafeInteger(pgid) || pgid < 1 || process.platform === 'win32' || processIsAlive(-pgid)) return;
  // An exclusive reaper prevents two observers from unlinking a replacement
  // lease. A crashed reaper deliberately requires operator recovery.
  const reaperPath = `${leasePath}.reaping`;
  let reaper;
  try { reaper = await open(reaperPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
  catch (error) { if (error?.code === 'EEXIST') return; throw error; }
  try {
    const current = await missing(leasePath);
    if (current && current.dev === owner.info.dev && current.ino === owner.info.ino && !processIsAlive(owner.value.pid) && !processIsAlive(-pgid)) await unlink(leasePath);
  } finally {
    await reaper.close();
    await unlink(reaperPath);
  }
}

async function sameFile(left, right) {
  const [a, b] = await Promise.all([stat(left, { bigint: true }), stat(right, { bigint: true })]);
  return a.dev === b.dev && a.ino === b.ino;
}

async function removeOwnTicket(ticketPath, token) {
  try {
    const owner = await readOwner(ticketPath);
    if (owner.value.token !== token || owner.value.pid !== process.pid) throw new Error('resource ticket ownership changed unexpectedly');
    await unlink(ticketPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function releaseOwnLease(leasePath, ticketPath, token) {
  const lease = await readOwner(leasePath);
  if (lease.value.token !== token || lease.value.pid !== process.pid || !(await sameFile(leasePath, ticketPath))) {
    throw new Error('refusing to release a resource lease not owned by this invocation');
  }
  await unlink(leasePath);
  await removeOwnTicket(ticketPath, token);
}

async function orderedTickets(waitersPath, leasePath) {
  const names = (await readdir(waitersPath)).filter(name => name.endsWith('.wait')).sort();
  const leaseInfo = await missing(leasePath);
  const live = [];
  for (const name of names) {
    const path = join(waitersPath, name);
    let owner;
    try {
      owner = await readOwner(path);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    const ownsLease = leaseInfo && owner.info.dev === leaseInfo.dev && owner.info.ino === leaseInfo.ino;
    if (!ownsLease && !processIsAlive(owner.value.pid)) {
      await unlink(path).catch(error => { if (error?.code !== 'ENOENT') throw error; });
      continue;
    }
    live.push(path);
  }
  return live;
}

async function createTicket(waitersPath) {
  const token = randomUUID();
  const order = `${String(Date.now()).padStart(13, '0')}-${process.hrtime.bigint().toString().padStart(20, '0')}`;
  const temporaryPath = join(waitersPath, `.creating-${process.pid}-${token}`);
  const ticketPath = join(waitersPath, `${order}-${process.pid}-${token}.wait`);
  const handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, pid: process.pid, pgid: processGroupId(), token })}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, ticketPath);
  return { token, ticketPath };
}

export async function withHostResource(options, callback) {
  const value = options ?? {};
  validate(value, callback);
  const { root, resource, signal, waitTimeoutMs, pollMs = 50 } = value;
  if (signal?.aborted) throw abortError(signal);

  const gatePath = join(resolve(root), '.host-resource-gates', resource);
  const waitersPath = join(gatePath, 'waiters');
  const leasePath = join(gatePath, 'lease');
  await mkdir(waitersPath, { recursive: true, mode: 0o700 });
  const { token, ticketPath } = await createTicket(waitersPath);
  const deadline = waitTimeoutMs === undefined ? undefined : Date.now() + waitTimeoutMs;
  let acquired = false;
  let result;
  let failure;
  try {
    while (!acquired) {
      if (signal?.aborted) throw abortError(signal);
      await recoverDeadLease(leasePath);
      const queue = await orderedTickets(waitersPath, leasePath);
      if (queue[0] === ticketPath && !(await missing(leasePath))) {
        try {
          await link(ticketPath, leasePath);
          acquired = true;
          break;
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
        }
      }
      if (deadline !== undefined && Date.now() >= deadline) throw new Error(`timed out waiting for host resource ${resource}`);
      await sleep(deadline === undefined ? pollMs : Math.max(1, Math.min(pollMs, deadline - Date.now())), signal);
    }
    if (signal?.aborted) throw abortError(signal);
    result = await callback();
  } catch (error) {
    failure = error;
  } finally {
    try {
      if (acquired) await releaseOwnLease(leasePath, ticketPath, token);
      else await removeOwnTicket(ticketPath, token);
    } catch (cleanupError) {
      failure = failure ? new AggregateError([failure, cleanupError], 'resource operation and cleanup both failed') : cleanupError;
    }
  }
  if (failure) throw failure;
  return result;
}

// Local developer runs can omit the gate. Production profiles supply the same
// absolute root on the host, so independent products share one compute queue.
export async function withHostCompute(callback, { env = process.env, signal } = {}) {
  const root = env.PIPELINE_HOST_RESOURCE_ROOT;
  if (!root) return callback();
  return withHostResource({ root, resource: 'compute', signal, pollMs: 250, waitTimeoutMs: 3_600_000 }, callback);
}
