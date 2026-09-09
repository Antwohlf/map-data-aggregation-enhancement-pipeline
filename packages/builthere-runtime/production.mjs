#!/usr/bin/env node
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';
import { postgresContract, runBuiltHere } from './runner.mjs';

export function parseArguments(args) {
  const options = {execute:false,batchSize:100,maxBatches:4,tipLimit:100};
  const fields = {'--workspace':'workspace','--env-file':'envFile','--batch-size':'batchSize','--max-batches':'maxBatches','--tip-limit':'tipLimit'};
  const seen = new Set();
  for (let index=0;index<args.length;index++) {
    const arg = args[index];
    if (seen.has(arg)) throw new Error('Duplicate BuiltHere argument'); seen.add(arg);
    if (arg === '--execute') options.execute = true;
    else if (Object.hasOwn(fields,arg) && args[index+1] && !args[index+1].startsWith('--')) {
      const field = fields[arg]; const value = args[++index];
      options[field] = ['batchSize','maxBatches','tipLimit'].includes(field) ? Number(value) : value;
    } else throw new Error('Invalid BuiltHere argument');
  }
  if (!isAbsolute(options.workspace || '') || options.envFile && !isAbsolute(options.envFile)) throw new Error('BuiltHere paths must be absolute');
  for (const [key,max] of [['batchSize',250],['maxBatches',1000],['tipLimit',1000]]) if (!Number.isSafeInteger(options[key]) || options[key]<1 || options[key]>max) throw new Error('Invalid BuiltHere bound');
  return options;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (!options.execute) { console.log(JSON.stringify({profile:'builthere-city',execute:false,sources:['detroit','ann-arbor','approved-community-tips'],batchSize:options.batchSize,maxBatches:options.maxBatches,tipLimit:options.tipLimit})); return; }
  const envFile = options.envFile || join(options.workspace,'secrets','runtime.env');
  const info = await lstat(envFile);
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077) throw new Error('BuiltHere environment must be a private regular file');
  const env = dotenv.parse(await readFile(envFile));
  if (!env.BUILTHERE_DATABASE_URL || !isAbsolute(env.PIPELINE_HOST_RESOURCE_ROOT || '')) throw new Error('Missing BuiltHere database or shared compute configuration');
  const connection = new URL(env.BUILTHERE_DATABASE_URL);
  if (!['postgres:','postgresql:'].includes(connection.protocol) || !connection.username || !connection.password || ['ant','postgres','neondb_owner'].includes(decodeURIComponent(connection.username))) throw new Error('BuiltHere requires dedicated database credentials');
  // Certificate validation is never disabled, including URLs originally emitted
  // by providers with the ambiguous libpq sslmode=require spelling.
  connection.searchParams.set('sslmode','verify-full');
  const client = new pg.Client({connectionString:connection.toString(),application_name:'builthere-pipeline-v1',connectionTimeoutMillis:15000,statement_timeout:120000});
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('BuiltHere run interrupted'));
  process.once('SIGTERM',stop); process.once('SIGINT',stop);
  try {
    await client.connect();
    const privileges = await client.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user');
    if (privileges.rows.length !== 1 || Object.values(privileges.rows[0]).some(Boolean)) throw new Error('BuiltHere database role exceeds runtime privileges');
    const summary = await runBuiltHere({...options,env,database:postgresContract(client),signal:controller.signal,onEvent:event => console.log(JSON.stringify(event))});
    console.log(JSON.stringify({type:'run_completed',...summary}));
  } finally { process.removeListener('SIGTERM',stop); process.removeListener('SIGINT',stop); await client.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  // Database errors can contain submitted values or connection details. Emit
  // only a bounded SQLSTATE/system code, never the provider's message.
  console.error(JSON.stringify({type:'run_failed',code:/^[A-Z0-9_]{2,32}$/.test(error?.code || '') ? error.code : 'BUILTHERE_RUNTIME_FAILURE'}));
  process.exitCode=1;
});
