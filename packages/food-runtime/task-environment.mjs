import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'dotenv';

const PRODUCTS = new Set(['apizzamichigan', 'tacoboutmichigan']);
const SHARED_TASKS = new Set(['classify', 'scrape', 'reconcile-classifier', 'feed-classifier', 'parse-menu', 'backup']);
const DATABASE_SECRETS = new Set(['PGPASSWORD', 'LOCAL_DB_PASSWORD']);
const SOURCE_SECRETS = new Set(['HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN', 'HUGGINGFACE_HUB_TOKEN', 'FSQ_PLACES_TOKEN', 'FOURSQUARE_API_KEY']);
const PUBLICATION_SECRETS = new Set(['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY', 'SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY']);

export function filterTaskEnvironment(environment, task) {
  const allowed = new Set([...DATABASE_SECRETS,
    ...(task === 'source' ? SOURCE_SECRETS : []),
    ...(task === 'publish' ? PUBLICATION_SECRETS : []),
  ]);
  return Object.fromEntries(Object.entries(environment).filter(([name]) => {
    if (task !== 'publish' && /SUPABASE/i.test(name)) return false;
    if (/(?:KEY|TOKEN|PASSWORD|SECRET)$/.test(name) && !allowed.has(name)) return false;
    return true;
  }));
}

function readPrivateEnvironment(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 65536) throw new Error('Task environment must be a private regular file under 64 KiB');
    const bytes = readFileSync(fd);
    if (bytes.length > 65536) throw new Error('Task environment exceeds 64 KiB');
    return parse(bytes);
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function loadTaskEnvironment({ workspace, profile, task }, inherited = process.env) {
  const productTask = ['source', 'publish'].includes(task) && PRODUCTS.has(profile);
  const sharedTask = SHARED_TASKS.has(task) && profile === 'food-shared';
  if (!productTask && !sharedTask) throw new Error('Unsupported task credential scope');
  const merged = {};
  for (const name of ['.env', '.env.local']) Object.assign(merged, readPrivateEnvironment(join(workspace, name)));
  if (task === 'publish') Object.assign(merged, readPrivateEnvironment(join(workspace, 'secrets/publication.env')));
  Object.assign(merged, readPrivateEnvironment(join(workspace, `secrets/${profile}.${task}.env`)), inherited);
  return filterTaskEnvironment(merged, task);
}
