/**
 * Where mutable state lives.
 *
 * Managed hosts (Railway, Render, Fly) give every deploy a fresh filesystem, so
 * anything written next to the code is gone on the next push. Point DATA_DIR at
 * a mounted volume and users, sessions and the key survive a redeploy.
 *
 * The repo's own data/ directory ships seed files (the TLD list and the
 * disposable blocklist). A brand-new volume is empty, so those are copied in
 * once on boot - without them the first requests would depend on a network
 * fetch succeeding.
 */
import { mkdir, copyFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The bundled seed data that ships with the code. Never written to. */
export const seedDir = join(repoRoot, 'data');

/** The writable data directory. Absolute, so a chdir cannot move it. */
export const dataDir = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : seedDir;

/** Cache files that can be re-fetched, so they are safe to copy from the seed. */
const SEED_FILES = ['tlds.txt', 'disposable-domains.txt'];

const exists = (p) => access(p).then(() => true, () => false);

/**
 * Create the data directory and seed it on first boot.
 * Safe to call more than once; existing files are never overwritten.
 */
/** Hosts that hand every deploy a fresh filesystem. */
const MANAGED_HOST = [
  ['RAILWAY_ENVIRONMENT', 'Railway'], ['RAILWAY_PROJECT_ID', 'Railway'],
  ['RENDER', 'Render'], ['FLY_APP_NAME', 'Fly.io'], ['DYNO', 'Heroku']
].find(([key]) => process.env[key]);

export async function initDataDir() {
  if (dataDir === seedDir) {
    // Writing into the repo is fine on a laptop and silent data loss on a
    // managed host: the next deploy ships a fresh checkout and every account,
    // credit balance and the signing key go with the old one. This used to
    // pass without a word, so the loss only showed up later as an empty user
    // list that nothing in the logs explained.
    if (MANAGED_HOST) {
      console.warn(
        `\n  WARNING: DATA_DIR is not set, so data is being written inside the app itself.\n` +
        `  ${MANAGED_HOST[1]} replaces that on every deploy, so users, credits, saved jobs\n` +
        `  and data/secret.key WILL BE LOST the next time you deploy.\n` +
        `  Fix: mount a volume and point DATA_DIR at it.\n`
      );
    }
    return dataDir;
  }

  // An unmounted volume or a read-only filesystem threw here and killed the
  // process before anything was logged. Say which path failed and why, then
  // let boot continue: the app still serves, it just cannot persist.
  try {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    console.warn(
      `\n  WARNING: DATA_DIR ${dataDir} is not writable (${err.code || err.message}).\n` +
      '  Logins and results cannot be saved. Point DATA_DIR at a mounted volume.\n'
    );
    return dataDir;
  }

  for (const name of SEED_FILES) {
    const target = join(dataDir, name);
    if (await exists(target)) continue;
    // A missing seed is not fatal: both lists fall back to a network fetch.
    await copyFile(join(seedDir, name), target).catch(() => {});
  }
  return dataDir;
}
