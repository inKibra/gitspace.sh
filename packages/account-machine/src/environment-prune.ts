import { existsSync } from 'node:fs';
import { lstat, open, readdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/** An unnamed entry younger than this stays: a release staged or downloaded but not yet selected. */
const KEEP_RECENT_MS = 2 * 24 * 60 * 60_000;
/** A rollback record names its plan's previous generation and database checkpoint until the plan finishes, in minutes;
 * one this old belongs to a plan that was interrupted and will not resume. */
const STALE_ROLLBACK_MS = 7 * 24 * 60 * 60_000;
/** Scratch the machine makes under the system temporary directory and removes when done; one this old was left by a
 * process that ended first. */
const TEMPORARY_PREFIXES = ['gitspace-checkpoint-', 'gitspace-push-', 'gitspace-boundaries-', 'gitspace-lfs-routing-', 'gitspace-lfs-delta-', 'gitspace-ssh-check-', 'gitspace-lifecycle-'];
const STALE_TEMPORARY_MS = 24 * 60 * 60_000;
/** The host's log has no rotation of its own: past this size its newest part moves to `machine.log.1`. */
const LOG_LIMIT_BYTES = 256 * 1024 * 1024;
const LOG_KEPT_BYTES = 32 * 1024 * 1024;
/** Written by earlier versions under the environment root and read by nothing now. */
const RETIRED_ENTRIES = ['runtime', 'omp-generations', 'omp-sessions', 'omp-selection.json'];
const RETIRED_PREFIXES = ['local-protocol2-omp-'];

export interface EnvironmentPruneInput {
  /** The host's environment root (`GITSPACE_ENVIRONMENT_ROOT`). */
  root: string;
  /** The machine's configuration directory: its `runtime-selection.json`, `machine.log` and earlier runtimes. */
  configRoot: string | null;
  /** The machine's cache directory (`~/.cache/gitspace`). */
  cacheRoot: string;
  /** The system temporary directory the machine's scratch goes to. */
  temporaryRoot: string;
  now: number;
}

/** Removes what releases and earlier versions left on disk; returns the paths removed. Anything a pointer file names
 * (by path, hash or name) stays: the selected and current generations and candidates, those an unfinished plan's
 * rollback record names, the selected bootstrap runtime and the bundle its host starts from. Nothing runs while an
 * update is in flight. */
export async function pruneEnvironment(input: EnvironmentPruneInput): Promise<string[]> {
  const { root, configRoot, cacheRoot, now } = input;
  if (existsSync(join(root, 'machine-update.json'))) return [];
  const removed: string[] = [];
  const remove = async (path: string) => {
    await rm(path, { recursive: true, force: true });
    removed.push(path);
  };
  const age = async (path: string) => now - (await lstat(path)).mtimeMs;
  for (const target of ['machine', 'frontend']) {
    for (const name of await entries(join(root, target))) {
      if (name.startsWith('rollback-') && name.endsWith('.json') && await age(join(root, target, name)) > STALE_ROLLBACK_MS) await remove(join(root, target, name));
    }
  }
  const named = await pointerText(root, configRoot);
  const prune = async (directory: string, keepRecent: boolean) => {
    for (const name of await entries(directory)) {
      if (named.includes(name.replace(/\.manifest\.json$/u, ''))) continue;
      if (keepRecent && await age(join(directory, name)) < KEEP_RECENT_MS) continue;
      await remove(join(directory, name));
    }
  };
  for (const directory of ['machine/generations', 'machine/sockets', 'frontend/generations', 'candidates', 'checkpoints', 'bootstrap-runtimes']) await prune(join(root, directory), true);
  for (const name of await entries(root)) {
    if (RETIRED_ENTRIES.includes(name) || RETIRED_PREFIXES.some(prefix => name.startsWith(prefix))) await remove(join(root, name));
  }
  if (configRoot) {
    await prune(join(configRoot, 'runtime'), true);
    if (existsSync(join(configRoot, 'runtime-provenance'))) await remove(join(configRoot, 'runtime-provenance'));
    await rotateLog(join(configRoot, 'machine.log'));
  }
  if (existsSync(join(cacheRoot, 'omp-runtimes'))) await remove(join(cacheRoot, 'omp-runtimes'));
  const temporary = input.temporaryRoot;
  for (const name of await entries(temporary)) {
    if (TEMPORARY_PREFIXES.some(prefix => name.startsWith(prefix)) && await age(join(temporary, name)) > STALE_TEMPORARY_MS) await remove(join(temporary, name));
  }
  return removed;
}

async function entries(directory: string): Promise<string[]> {
  return readdir(directory).catch(() => []);
}

/** Every pointer file's text, in which a kept entry's name appears: the root's selections, the machine and frontend
 * current and rollback records, the bootstrap selection, and the selected bootstrap runtime's `host.js`, which names
 * the bundle it starts from. */
async function pointerText(root: string, configRoot: string | null): Promise<string> {
  const files: string[] = [];
  for (const directory of [root, join(root, 'machine'), join(root, 'frontend')]) {
    for (const name of await entries(directory)) if (name.endsWith('.json')) files.push(join(directory, name));
  }
  if (configRoot) {
    files.push(join(configRoot, 'runtime-selection.json'));
    const selected = await readFile(join(configRoot, 'runtime-selection.json'), 'utf8').then(text => z.object({ path: z.string() }).safeParse(JSON.parse(text)), () => null);
    if (selected?.success) files.push(join(selected.data.path, 'host.js'));
  }
  const texts = await Promise.all(files.map(file => readFile(file, 'utf8').catch(() => '')));
  return texts.join('\n');
}

/** Moves the newest LOG_KEPT_BYTES of a log past LOG_LIMIT_BYTES to `<log>.1` and empties the log in place: its
 * writers hold it open for appending, so it is truncated, never renamed. */
async function rotateLog(path: string): Promise<void> {
  const size = await lstat(path).then(stats => stats.size, () => 0);
  if (size <= LOG_LIMIT_BYTES) return;
  const file = await open(path, 'r');
  try {
    const tail = Buffer.alloc(LOG_KEPT_BYTES);
    const { bytesRead } = await file.read(tail, 0, LOG_KEPT_BYTES, size - LOG_KEPT_BYTES);
    await writeFile(`${path}.1`, tail.subarray(0, bytesRead), { mode: 0o600 });
  } finally { await file.close(); }
  await truncate(path, 0);
}
