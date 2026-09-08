#!/usr/bin/env node
// Compatibility process adapter: proven food jobs, isolated code and private state.
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeTrustedHostStagesAsync } from '../executor/trusted-host.mjs';
import { loadTaskEnvironment, filterTaskEnvironment } from './task-environment.mjs';

export const codeRoot = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(join(codeRoot, 'config/production-tasks.json'), 'utf8'));
const taskAdapters = Object.freeze({
  source: { id: 'food.source-cycle', kind: 'source' },
  publish: { id: 'food.guarded-publication', kind: 'output' },
  classify: { id: 'food.classifier', kind: 'transform' },
  scrape: { id: 'food.website-scraper', kind: 'source' },
  'reconcile-classifier': { id: 'food.classifier-reconciliation', kind: 'maintenance' },
  'feed-classifier': { id: 'food.classifier-feeder', kind: 'maintenance' },
  'parse-menu': { id: 'food.menu-parser', kind: 'transform' },
  backup: { id: 'food.backup', kind: 'maintenance' },
});

// Scheduled tasks are independently invoked graph nodes: publication does not
// bypass its existing health/review gates or imply every source cycle is ready.
export function executeProductionTask(plan, { profile, task }, run = supervisedCompletion) {
  if (!Object.hasOwn(taskAdapters, task)) throw new Error('Unknown production task');
  const adapter = taskAdapters[task];
  return executeTrustedHostStagesAsync({
    definition: {
      schemaVersion: 1,
      id: `${profile}-${task}`,
      stages: [{ id: task, adapter: adapter.id, version: 1, kind: adapter.kind, dependsOn: [], config: {} }],
    },
    registry: [{ ...adapter, version: 1, run: () => run(plan) }],
  });
}

function supervisedCompletion(plan) {
  return new Promise((resolveCompletion, reject) => {
    const child = superviseTask(plan);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code !== 0 || signal || process.exitCode) reject(Object.assign(
        new Error(`Production adapter failed (exit=${code}, signal=${signal || 'none'})`),
        { exitCode: process.exitCode || code || 1 },
      ));
      else resolveCompletion({ exitCode: 0 });
    });
  });
}

function contained(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

export function validateWorkspace(directory) {
  if (!directory || !isAbsolute(directory)) throw new Error('An absolute private workspace is required');
  const workspace = realpathSync(directory);
  const repository = realpathSync(resolve(codeRoot, '../..'));
  if (contained(repository, workspace) || contained(workspace, repository)) {
    throw new Error('Workspace must be separate from the code repository');
  }
  if ((lstatSync(workspace).mode & 0o077) !== 0) throw new Error('Private workspace must have mode 0700');
  return workspace;
}

function sourceFiles(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(prefix, entry.name);
    if (entry.name.startsWith('.') || entry.name.endsWith('.test.mjs')) return [];
    return entry.isDirectory() ? sourceFiles(join(directory, entry.name), path) : [path];
  });
}

// Link individual code files, never entire mutable directories. Refuse to replace
// any file or an unexpected link so preparation cannot erase existing state.
export function prepareWorkspace(directory) {
  const workspace = validateWorkspace(directory);
  const links = ['scripts', 'config'].flatMap(folder => sourceFiles(join(codeRoot, folder), folder));
  for (const path of links) {
    const destination = join(workspace, path);
    let current;
    try { current = lstatSync(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current && (!current.isSymbolicLink() || !existsSync(destination) || realpathSync(destination) !== realpathSync(join(codeRoot, path)))) {
      throw new Error(`Refusing to replace existing workspace file: ${path}`);
    }
    // Also refuse parent directory symlinks, which could redirect writes.
    let parent = dirname(destination);
    while (parent !== workspace) {
      let parentStat;
      try { parentStat = lstatSync(parent); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (parentStat?.isSymbolicLink()) throw new Error(`Workspace directory cannot be a symlink: ${relative(workspace, parent)}`);
      parent = dirname(parent);
    }
  }
  for (const path of links) {
    const destination = join(workspace, path);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    if (!existsSync(destination)) symlinkSync(join(codeRoot, path), destination);
  }
  return { linkedFiles: links.length };
}

export function planTask({ profile, task, workspace }, environment = process.env) {
  const definition = catalog.tasks[task];
  if (!Object.hasOwn(catalog.tasks, task)) throw new Error('Unknown production task');
  const selected = catalog.profiles[profile];
  if (definition.shared ? profile !== 'food-shared' : !Object.hasOwn(catalog.profiles, profile)) {
    throw new Error('Shared tasks require food-shared; source/publication require a product profile');
  }
  const args = selected ? selected[definition.profileArgs] : definition.args;
  const env = { ...filterTaskEnvironment(environment, task), QUEUE_DB_PATH: join(workspace, 'scripts/.job-queue.db') };
  if (selected) {
    env.APIZZA_SYNC_ENTITY = selected.entity;
    env.SOURCE_PIPELINE_CONFIG = selected.sourceConfig;
    const stem = selected.sourceConfig.split('/').at(-1).replace(/\.json$/, '');
    env.SOURCE_PIPELINE_STATE = join(workspace, `scripts/.${stem}-state.json`);
    env.SOURCE_PIPELINE_LAST_REPORT = join(workspace, `scripts/.${stem}-last-report.json`);
    env.SOURCE_PIPELINE_LAST_DRY_RUN = join(workspace, `scripts/.${stem}-last-dry-run.json`);
    env.APIZZA_SYNC_CHECKPOINT = join(workspace, `scripts/.${selected.publishStateStem}-sync-checkpoint.json`);
    env.APIZZA_SYNC_STATUS_FILE = join(workspace, `scripts/.${selected.publishStateStem}-sync-status.json`);
    env.APIZZA_SYNC_RECONCILE_CHECKPOINT = join(workspace, `scripts/.${selected.publishStateStem}-reconcile-checkpoint.json`);
  } else {
    // Existing shared queue workers claim both products, without a product override.
    delete env.APIZZA_SYNC_ENTITY;
    delete env.SOURCE_PIPELINE_CONFIG;
  }
  return { command: process.execPath, args: [join(codeRoot, definition.script), ...args], cwd: workspace, env };
}

async function main(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (['--execute', '--prepare'].includes(flag)) options[flag.slice(2)] = true;
    else if (['--profile', '--task', '--workspace'].includes(flag) && argv[index + 1] && !argv[index + 1].startsWith('--')) options[flag.slice(2)] = argv[++index];
    else throw new Error(`Unknown or incomplete option: ${flag}`);
  }
  const workspace = validateWorkspace(options.workspace);
  if (options.prepare) {
    if (options.execute || options.task || options.profile) throw new Error('Preparation cannot also run a task');
    console.log(JSON.stringify(prepareWorkspace(workspace)));
    return;
  }
  const plan = planTask({ ...options, workspace }, loadTaskEnvironment({ ...options, workspace }));
  if (!options.execute) {
    console.log(JSON.stringify({ profile: options.profile, task: options.task, command: plan.command, args: plan.args, cwd: plan.cwd, execute: false }));
    return;
  }
  if (existsSync(join(workspace, 'STAGING-NOT-ACTIVE.json'))) {
    throw new Error('Workspace is staged only; complete the coordinated cutover before execution');
  }
  if (!existsSync(plan.env.QUEUE_DB_PATH)) {
    throw new Error('Existing food queue is required; refusing to create an empty production queue');
  }
  // A separate deliberate flag is required: printing a plan cannot start writers.
  // Exporters spawn grandchildren. Forward shutdown to the process group, not
  // just the intermediate Node process, so a stopped job cannot leave writers.
  await executeProductionTask(plan, options);
}

export function superviseTask(plan, { graceMs = 5000 } = {}) {
  const grouped = process.platform !== 'win32';
  const child = spawn(plan.command, plan.args, { cwd: plan.cwd, env: plan.env, stdio: 'inherit', detached: grouped });
  let stopping = false;
  const send = signal => {
    if (!child.pid) return;
    try { if (grouped) process.kill(-child.pid, signal); else child.kill(signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const stop = signal => {
    if (stopping) return;
    stopping = true;
    process.exitCode = 1;
    send(signal);
    // Keep this timer alive even if the direct child exits first: grandchildren
    // in its process group may still be running. Escalate before launchd does.
    setTimeout(() => { send('SIGKILL'); cleanup(); }, graceMs);
  };
  const terminate = () => stop('SIGTERM');
  const interrupt = () => stop('SIGINT');
  const cleanup = () => {
    process.removeListener('SIGTERM', terminate);
    process.removeListener('SIGINT', interrupt);
  };
  process.on('SIGTERM', terminate);
  process.on('SIGINT', interrupt);
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    process.exitCode = stopping ? 1 : code ?? (signal ? 1 : 0);
    if (!stopping) cleanup();
  });
  return child;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = error.exitCode || 1; });
}
