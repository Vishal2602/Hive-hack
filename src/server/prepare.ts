import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Hides credentials in a clone URL (https://user:token@host/... -> https://***@host/...). */
export function maskUrl(url: string): string { return url.replace(/\/\/[^/@]+@/, '//***@'); }

/**
 * First boot on a host: when HIVE_REPO_URL is set and the project root is missing or empty, clone the
 * team's repository there and install its packages (with --ignore-scripts, so nothing from the repo runs).
 * An existing checkout is never touched. Clones into a temp folder first, so a failed boot leaves nothing half-made.
 */
export function prepareRepository(root: string, env: NodeJS.ProcessEnv = process.env): 'cloned' | 'existing' | 'skipped' {
  const url = env.HIVE_REPO_URL?.trim();
  if (existsSync(root) && readdirSync(root).length > 0) return 'existing';
  if (!url) return 'skipped';
  const branch = env.HIVE_REPO_BRANCH?.trim();
  const temp = `${root}.cloning-${process.pid}`;
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(dirname(root), { recursive: true });
  console.error(`Hive: cloning ${maskUrl(url)}${branch ? ` (${branch})` : ''} into ${root}`);
  const clone = spawnSync('git', ['clone', '--quiet', ...(branch ? ['--branch', branch] : []), url, temp], { encoding: 'utf8', timeout: 300_000 });
  if (clone.status !== 0) {
    rmSync(temp, { recursive: true, force: true });
    throw new Error(`git clone of ${maskUrl(url)} failed: ${(clone.stderr ?? '').split(url).join(maskUrl(url)).trim().slice(0, 500)}`);
  }
  if (existsSync(join(temp, 'package-lock.json'))) {
    console.error('Hive: installing the repository\'s packages (npm ci --ignore-scripts)');
    const install = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: temp, encoding: 'utf8', timeout: 600_000 });
    if (install.status !== 0) console.error(`Hive: npm ci failed; type checks may miss package types: ${(install.stderr ?? '').trim().slice(-500)}`);
  }
  rmSync(root, { recursive: true, force: true });
  renameSync(temp, root);
  return 'cloned';
}
