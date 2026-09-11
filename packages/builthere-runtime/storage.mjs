import { createHash } from 'node:crypto';
import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';

// Compare the LAST accepted version, not a set of every version ever seen:
// A -> B -> A is a real update. Review/verification are intentionally excluded.
export function commandVersion(command) {
  const m = command.metadata;
  return createHash('sha256').update(JSON.stringify([
    m.contractVersion, m.transformVersion, m.policyVersion, m.sourceDigest, m.mappedDigest,
  ])).digest('hex');
}

export const DEFAULT_STORAGE_POLICY = Object.freeze({
  databaseMaxBytes: 450_000_000,
  reservePerCommandBytes: 65_536,
  workspaceMaxBytes: 512_000_000,
  refreshHours: 24,
});

export function storagePolicy(overrides = {}) {
  const result = { ...DEFAULT_STORAGE_POLICY, ...overrides };
  for (const [key, value] of Object.entries(result)) {
    if (!Object.hasOwn(DEFAULT_STORAGE_POLICY, key) || !Number.isSafeInteger(value) || value < 1) throw new Error('Invalid BuiltHere storage policy');
  }
  return result;
}

export function assertDatabaseBudget(bytes, commands, policy) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(commands) || commands < 0) throw new Error('Invalid database storage measurement');
  if (bytes + commands * policy.reservePerCommandBytes >= policy.databaseMaxBytes) {
    throw Object.assign(new Error('BuiltHere database storage budget reached'), { code: 'BUILTHERE_STORAGE_BUDGET' });
  }
}

export async function assertWorkspaceBudget(root, policy, reserveBytes = 0) {
  if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 0) throw new Error('Invalid workspace reservation');
  let total = 0;
  async function visit(path) {
    for (const name of await readdir(path)) {
      const child = join(path, name);
      const info = await lstat(child);
      if (info.isSymbolicLink()) throw new Error('BuiltHere workspace must not contain symlinks');
      if (info.isDirectory()) await visit(child); else total += info.size;
      if (total + reserveBytes >= policy.workspaceMaxBytes) throw Object.assign(new Error('BuiltHere private workspace budget reached'), { code: 'BUILTHERE_WORKSPACE_BUDGET' });
    }
  }
  await visit(root);
  return total;
}
