import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';

/**
 * Load the private runtime files while preserving explicit process/launchd
 * authority: .env < .env.local < inherited environment.
 */
export function loadRuntimeEnvironment({ root = process.cwd(), inherited = process.env } = {}) {
  const fileEnvironment = {};
  for (const name of ['.env', '.env.local']) {
    const path = resolve(root, name);
    if (existsSync(path)) Object.assign(fileEnvironment, parse(readFileSync(path)));
  }
  return { ...fileEnvironment, ...inherited };
}
