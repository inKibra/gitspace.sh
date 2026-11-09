import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pruneEnvironment } from '../src/environment-prune.js';

const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 10, 9);
const CURRENT = 'a'.repeat(64), PREVIOUS = 'b'.repeat(64), OLD = 'c'.repeat(64), STAGED = 'd'.repeat(64);

/** A machine's directories, each entry written `daysOld` days before NOW. */
async function machineDisk(run: (paths: { root: string; config: string; cache: string; temporary: string; at(...path: string[]): string }) => Promise<void>) {
  const base = await mkdtemp(join(tmpdir(), 'gitspace-prune-proof-'));
  try {
    const root = join(base, 'config', 'machine'), config = join(base, 'config'), cache = join(base, 'cache'), temporary = join(base, 'tmp');
    await run({ root, config, cache, temporary, at: (...path) => join(base, ...path) });
  } finally { await rm(base, { recursive: true, force: true }); }
}

async function put(path: string, daysOld: number, content: string | null = null) {
  if (content === null) await mkdir(path, { recursive: true });
  else { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); }
  const at = new Date(NOW - daysOld * DAY);
  await utimes(path, at, at);
}

test('pruning keeps what pointers name and recent entries, and removes old unnamed releases and retired paths', () => machineDisk(async ({ root, config, cache, temporary }) => {
  const generation = (hash: string) => join(root, 'machine', 'generations', hash);
  await put(generation(CURRENT), 30);
  await put(generation(PREVIOUS), 30);
  await put(generation(OLD), 30);
  await put(generation(STAGED), 0);
  await put(join(root, 'machine', 'current.json'), 1, JSON.stringify({ hash: `sha256:${CURRENT}`, artifactPath: join(generation(CURRENT), 'machine') }));
  // An unfinished plan's rollback record keeps its previous generation; a stale one is removed and keeps nothing.
  await put(join(root, 'machine', 'rollback-dep_live-1.json'), 1, JSON.stringify({ previous: { hash: `sha256:${PREVIOUS}` } }));
  await put(join(root, 'machine', 'rollback-dep_stale-1.json'), 40, JSON.stringify({ previous: { hash: `sha256:${OLD}` } }));
  await put(join(root, 'candidates', 'machine-selected'), 30);
  await put(join(root, 'candidates', 'machine-selected.manifest.json'), 30, '{}');
  await put(join(root, 'candidates', 'machine-unused'), 30);
  await put(join(root, 'candidates', 'machine-unused.manifest.json'), 30, '{}');
  await put(join(root, 'host-selection.json'), 1, JSON.stringify({ path: join(root, 'candidates', 'machine-selected') }));
  await put(join(root, 'bootstrap-runtimes', 'selected-runtime', 'host.js'), 30, `process.env.GITSPACE_BUNDLE_ROOT = ${JSON.stringify(join(config, 'runtime', 'recovery-bundle'))};`);
  await put(join(config, 'runtime-selection.json'), 30, JSON.stringify({ path: join(root, 'bootstrap-runtimes', 'selected-runtime') }));
  await put(join(config, 'runtime', 'recovery-bundle'), 60);
  await put(join(config, 'runtime', CURRENT.replace(/a/gu, 'e')), 60);
  await put(join(root, 'omp-generations'), 60);
  await put(join(root, 'local-protocol2-omp-1789280283766'), 30);
  await put(join(root, 'gitspace.db'), 0, 'database');
  await put(join(cache, 'omp-runtimes'), 30);
  await put(join(temporary, 'gitspace-checkpoint-left'), 3);
  await put(join(temporary, 'gitspace-checkpoint-running'), 0);
  await put(join(temporary, 'gitspace-ssh'), 3);

  await pruneEnvironment({ root, configRoot: config, cacheRoot: cache, temporaryRoot: temporary, now: NOW });

  const kept = [generation(CURRENT), generation(PREVIOUS), generation(STAGED), join(root, 'machine', 'rollback-dep_live-1.json'),
    join(root, 'candidates', 'machine-selected'), join(root, 'candidates', 'machine-selected.manifest.json'), join(root, 'bootstrap-runtimes', 'selected-runtime'),
    join(config, 'runtime', 'recovery-bundle'), join(root, 'gitspace.db'), join(temporary, 'gitspace-checkpoint-running'), join(temporary, 'gitspace-ssh')];
  const removed = [generation(OLD), join(root, 'machine', 'rollback-dep_stale-1.json'), join(root, 'candidates', 'machine-unused'), join(root, 'candidates', 'machine-unused.manifest.json'),
    join(config, 'runtime', CURRENT.replace(/a/gu, 'e')), join(root, 'omp-generations'), join(root, 'local-protocol2-omp-1789280283766'), join(cache, 'omp-runtimes'), join(temporary, 'gitspace-checkpoint-left')];
  expect(kept.filter(path => !existsSync(path))).toEqual([]);
  expect(removed.filter(path => existsSync(path))).toEqual([]);
}));

test('pruning does nothing while a machine update is in flight', () => machineDisk(async ({ root, config, cache, temporary }) => {
  await put(join(root, 'machine', 'generations', OLD), 30);
  await put(join(root, 'omp-generations'), 60);
  await put(join(root, 'machine-update.json'), 0, '{}');
  expect(await pruneEnvironment({ root, configRoot: config, cacheRoot: cache, temporaryRoot: temporary, now: NOW })).toEqual([]);
  expect(existsSync(join(root, 'machine', 'generations', OLD))).toBe(true);
  expect(existsSync(join(root, 'omp-generations'))).toBe(true);
}));
