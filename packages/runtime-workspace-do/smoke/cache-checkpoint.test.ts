import { wranglerWorkerModules } from './search-wasm.js';
import { test, expect } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import { createGitIntermediateCheckpoint, restoreGitIntermediateCheckpoint } from '../../account-machine/src/git-checkpoint.js';

for (const scenario of ['source', 'empty', 'unborn']) test(`first cache reaches ready from ${scenario === 'source' ? 'canonical committed source' : scenario === 'unborn' ? 'canonical unborn checkpoint' : 'empty Artifacts namespace and real local Git HEAD'}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gitspace-cache-checkpoint-'));
  let worker: Miniflare | undefined;
  try {
    const git = async (...args: string[]) => {
      const process = Bun.spawn(['git', ...args], { cwd: directory, stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, status] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
      if (status !== 0) throw new Error(stderr);
      return stdout.trim();
    };
    await git('init', '-b', 'main');
    await git('config', 'user.email', 'proof@example.invalid');
    await git('config', 'user.name', 'Checkpoint proof');
    await writeFile(join(directory, 'tracked.txt'), 'base\n');
    if (scenario !== 'unborn') { await git('add', '.'); await git('commit', '-m', 'base'); }
    const local = await createGitIntermediateCheckpoint({ repositoryPath: directory, spaceId: 'workspace', revision: 1 });
    const head = scenario === 'unborn' ? null : await git('rev-parse', 'HEAD');
    const checkpoint = scenario === 'source' && head !== null ? { ...local, headCommit: head, indexCommit: head, trackedWorktreeCommit: head, worktreeCommit: head } : local;
    const config = join(directory, 'wrangler.json');
    await writeFile(config, JSON.stringify({ name: 'local-cache-checkpoint-proof', main: new URL('./cache-checkpoint-fixture.ts', import.meta.url).pathname, compatibility_date: '2026-03-02', compatibility_flags: ['nodejs_compat'] }));
    const build = Bun.spawn([process.execPath, 'x', 'wrangler', 'deploy', '--dry-run', '--config', config, '--outdir', join(directory, 'bundle')], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    build.stdin.end();
    const [buildOut, buildError, buildExit] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
    if (buildExit !== 0) throw new Error(buildOut + buildError);
    worker = new Miniflare({
      modules: await wranglerWorkerModules(join(directory, 'bundle'), 'cache-checkpoint-fixture.js'), modulesRoot: join(directory, 'bundle'),
      compatibilityDate: '2026-03-02', compatibilityFlags: ['nodejs_compat'], bindings: { ACCOUNT_ID: 'account' },
      durableObjects: { PROOF: { className: 'CacheCheckpointProof', useSQLite: true }, SPACE_AUTHORITY: { className: 'CacheCheckpointProof', useSQLite: true }, PROJECT_AUTHORITY: { className: 'CheckpointMetadata', useSQLite: true }, FLEET_CATALOG: { className: 'CheckpointMetadata', useSQLite: true }, CREDENTIALS: { className: 'CheckpointMetadata', useSQLite: true }, USER_SETTINGS: { className: 'UserSettingsDO', useSQLite: true } },
      outboundService: () => { throw new Error('Live provider access forbidden'); },
    });
    const response = await worker.dispatchFetch(`http://proof/${scenario}`, { method: 'POST', body: JSON.stringify(checkpoint) });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ passed: true });
    await writeFile(join(directory, 'tracked.txt'), 'discarded local change\n');
    await restoreGitIntermediateCheckpoint({ repositoryPath: directory, checkpoint, branch: 'main' });
    expect(await Bun.file(join(directory, 'tracked.txt')).text()).toBe('base\n');
    if (head === null) {
      expect(await git('symbolic-ref', 'HEAD')).toBe('refs/heads/main');
      expect(await git('show-ref', '--head')).not.toContain('refs/heads/main');
      expect(await git('status', '--porcelain', '--', 'tracked.txt')).toBe('?? tracked.txt');
    } else expect(await git('rev-parse', 'HEAD')).toBe(head);
  } finally { await worker?.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);
