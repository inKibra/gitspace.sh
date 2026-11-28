import { afterEach, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectCopyOperation } from '@gitspace/protocol/rpc-contract';
import { ArtifactsGitRemote } from '../src/artifacts-git-remote.js';
import { ProjectCopies, type ProjectCopyOptions } from '../src/project-lifecycle.js';
import { atomicJson } from '../src/machine-update.js';

const ORIGIN_URL = 'https://github.com/acme-labs/widgets.git';
const MOVED_URL = 'https://github.com/acme-labs/gadgets.git';
const ARTIFACTS_URL = 'https://artifacts.invalid/repository';
const roots: string[] = [];
const globalConfig = Bun.env.GIT_CONFIG_GLOBAL;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (globalConfig === undefined) delete Bun.env.GIT_CONFIG_GLOBAL;
  else Bun.env.GIT_CONFIG_GLOBAL = globalConfig;
});
function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: { ...Bun.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.invalid' } });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
function fails(cwd: string, ...args: string[]): boolean {
  return Bun.spawnSync(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' }).exitCode !== 0;
}
async function finished(copies: ProjectCopies, operationId: string): Promise<ProjectCopyOperation> {
  for (;;) {
    const copy = await copies.read('widgets', operationId);
    if (copy === null) throw new Error(`No copy ${operationId}`);
    if (copy.state !== 'running') return copy;
    // The copy runs real git processes in the background; clients follow it by reading it, as here.
    await Bun.sleep(10);
  }
}

/** An origin this machine reaches over file://, a bare repository standing in for the project's Artifacts repository
 * reached at its HTTPS address, and the machine's data directory. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-project-copy-')); roots.push(root);
  const origin = join(root, 'origin');
  git(root, 'init', '-q', '-b', 'main', origin);
  const artifacts = join(root, 'artifacts.git');
  git(root, 'init', '-q', '--bare', artifacts);
  git(artifacts, 'config', 'receive.shallowUpdate', 'true');
  // Artifacts serves any reachable object by id.
  git(artifacts, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  writeFileSync(join(root, 'gitconfig'), `[url "${artifacts}"]\n\tinsteadOf = ${ARTIFACTS_URL}\n`);
  Bun.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig');
  const machine = join(root, 'machine');
  const cache = join(machine, 'origins', 'widgets.git');
  let files = 0;
  const commit = (content: string) => {
    // Each commit adds a file: its own objects are the commit, the root tree and the file.
    writeFileSync(join(origin, `file-${++files}`), content); git(origin, 'add', '.'); git(origin, 'commit', '-qm', content);
    return git(origin, 'rev-parse', 'HEAD');
  };
  const scopes: string[] = [];
  const checkouts: string[] = [];
  const reach: Record<string, string> = { [ORIGIN_URL]: `file://${origin}`, [MOVED_URL]: `file://${origin}` };
  const project = { repositoryReference: ORIGIN_URL, baseBranch: 'HEAD' };
  /** The machine as a fresh process sees it: a remote holding no lease requests and records every credential. */
  const machineCopies = (options: Partial<ProjectCopyOptions> = {}) => new ProjectCopies({
    project: async () => project, root: machine, checkouts: () => checkouts,
    gitEnvironment: url => ({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${reach[url]}.insteadOf`, GIT_CONFIG_VALUE_0: url }),
    projectRepository: new ArtifactsGitRemote({ credentials: async (_binding, scope) => {
      scopes.push(scope);
      return { remote: ARTIFACTS_URL, plaintext: 'offline', expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    } }),
    updateBase: async () => { throw new Error('Only copies are asked for here'); },
    ...options,
  });
  const copy = async (options: Partial<ProjectCopyOptions> = {}) => {
    const copies = machineCopies(options);
    return finished(copies, (await copies.start('widgets')).operationId);
  };
  const copied = () => git(artifacts, 'for-each-ref', '--format=%(refname) %(objectname)');
  /** What a git cut short left in the cache, and copies from before the cache left under the data directory. */
  const leftovers = () => [
    ...readdirSync(machine).filter(name => name.startsWith('seed-')),
    ...readdirSync(join(cache, 'objects', 'pack')).filter(name => name.startsWith('tmp_')),
    ...readdirSync(cache, { recursive: true }).map(String).filter(name => name.endsWith('.lock')),
  ];
  return { root, origin, artifacts, machine, cache, commit, copy, machineCopies, scopes, checkouts, project, reach, copied, leftovers };
}

it('fast-forwards a copy behind its origin, sending only the commits after it, with history linked', async () => {
  const f = fixture();
  const first = f.commit('first');
  const copiedAt = f.commit('second');
  expect(await f.copy()).toMatchObject({ state: 'moved', phase: null, baseBranch: 'main', previous: null, commit: copiedAt, error: null });
  expect(fails(f.artifacts, 'cat-file', '-e', first)).toBe(true);
  const before = new Set(git(f.artifacts, 'rev-list', '--objects', '--all').split('\n').map(line => line.split(' ')[0]));
  f.commit('third');
  const tip = f.commit('fourth');

  expect(await f.copy()).toMatchObject({ state: 'moved', baseBranch: 'main', previous: copiedAt, commit: tip });
  expect(f.copied()).toBe(`refs/heads/main ${tip}`);
  // Linked: the copied tip's history reaches the commit the copy held, which stays its shallow end.
  git(f.artifacts, 'merge-base', '--is-ancestor', copiedAt, tip);
  expect(git(f.artifacts, 'rev-list', tip).split('\n')).toEqual(git(f.origin, 'rev-list', tip, '--not', first).split('\n'));
  expect(fails(f.artifacts, 'cat-file', '-e', first)).toBe(true);
  // Exactly the objects of the new commits arrived.
  const added = git(f.artifacts, 'rev-list', '--objects', '--all').split('\n').map(line => line.split(' ')[0]).filter(id => !before.has(id)).sort();
  expect(added).toEqual(git(f.origin, 'rev-list', '--objects', tip, '--not', copiedAt).split('\n').map(line => line.split(' ')[0]).sort());
});

it('refuses a copy at a commit outside its origin\'s history, naming both commits and leaving it where it was', async () => {
  const f = fixture();
  const first = f.commit('first');
  const copiedAt = f.commit('second');
  await f.copy();
  // The origin's main is rewritten; the copied commit stays reachable from another branch for now.
  git(f.origin, 'branch', 'kept', copiedAt);
  git(f.origin, 'reset', '-q', '--hard', first);
  const rewritten = f.commit('rewritten');
  const refusal = `The project's copy of main is at ${copiedAt.slice(0, 7)}, which origin's main (${rewritten.slice(0, 7)}) does not build on, so it was not moved: GitSpace only fast-forwards it.`;
  expect(await f.copy()).toMatchObject({ state: 'diverged', previous: copiedAt, commit: rewritten, error: refusal });
  expect(f.copied()).toBe(`refs/heads/main ${copiedAt}`);
  // Once the origin no longer holds the copied commit at all, the copy is refused the same way.
  git(f.origin, 'branch', '-D', 'kept');
  git(f.origin, 'reflog', 'expire', '--expire=now', '--all');
  git(f.origin, 'gc', '-q', '--prune=now');
  expect(fails(f.origin, 'cat-file', '-e', copiedAt)).toBe(true);
  rmSync(f.cache, { recursive: true, force: true });
  expect(await f.copy()).toMatchObject({ state: 'diverged', previous: copiedAt, error: refusal });
  expect(f.copied()).toBe(`refs/heads/main ${copiedAt}`);
});

it('leaves a copy already at its origin\'s tip as it is, without writing', async () => {
  const f = fixture();
  f.commit('first');
  const tip = f.commit('second');
  await f.copy();
  f.scopes.splice(0);
  const hook = join(f.artifacts, 'hooks/pre-receive');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n'); chmodSync(hook, 0o755);
  expect(await f.copy()).toMatchObject({ state: 'current', baseBranch: 'main', previous: tip, commit: tip });
  expect(f.scopes).toEqual(['read']);
  expect(f.copied()).toBe(`refs/heads/main ${tip}`);
});

it('fills a new cache from a checkout of the project on the machine, fetching only what it lacks from the origin', async () => {
  const f = fixture();
  f.commit('first');
  const checkedOut = f.commit('second');
  // A workspace checkout copied in from a tip holds that tip alone.
  const checkout = join(f.root, 'workspace');
  git(f.root, 'clone', '-q', '--depth', '1', `file://${f.origin}`, checkout);
  f.checkouts.push(join(f.root, 'gone'), checkout);
  const tip = f.commit('third');

  const copy = await f.copy();
  expect(copy).toMatchObject({ state: 'moved', previous: null, commit: tip, filledFrom: checkout, fresh: null });
  expect(copy.received.objects).toBe(git(f.origin, 'rev-list', '--objects', tip, '--not', checkedOut).split('\n').length);
  expect(f.copied()).toBe(`refs/heads/main ${tip}`);
  expect(git(f.cache, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main');
});

it('continues the cache on a later copy, fetching only the new commits', async () => {
  const f = fixture();
  f.commit('first');
  const copiedAt = f.commit('second');
  await f.copy();
  const tip = f.commit('third');

  const copy = await f.copy();
  expect(copy).toMatchObject({ state: 'moved', previous: copiedAt, commit: tip, fresh: null, filledFrom: null });
  expect(copy.received.objects).toBe(git(f.origin, 'rev-list', '--objects', tip, '--not', copiedAt).split('\n').length);
});

it('checks the cache only after a copy that did not finish cleanly, starting it over when objects are missing or the origin changed', async () => {
  const f = fixture();
  f.commit('first');
  const copiedAt = f.commit('second');
  await f.copy();
  // The copied commit's root tree goes missing.
  const tree = git(f.cache, 'rev-parse', `${copiedAt}^{tree}`);
  rmSync(join(f.cache, 'objects', tree.slice(0, 2), tree.slice(2)));
  f.commit('third');
  // The last copy finished cleanly, so git does not check the cache.
  expect(await f.copy()).toMatchObject({ fresh: null });
  // A copy that fails leaves the next one to check it.
  f.reach[ORIGIN_URL] = `file://${join(f.root, 'missing')}`;
  expect(await f.copy()).toMatchObject({ state: 'failed' });
  f.reach[ORIGIN_URL] = `file://${f.origin}`;
  const tip = f.commit('fourth');

  expect(await f.copy()).toMatchObject({ state: 'moved', commit: tip, fresh: expect.stringContaining('the cache failed git fsck --connectivity-only') });
  expect(fails(f.cache, 'fsck', '--connectivity-only')).toBe(false);
  f.project.repositoryReference = MOVED_URL;
  const moved = f.commit('fifth');
  expect(await f.copy()).toMatchObject({ state: 'moved', previous: tip, commit: moved, fresh: `the project's origin changed from ${ORIGIN_URL} to ${MOVED_URL}` });
});

it('runs Update base itself once a copy started for it moved or was current, with nothing reading the copy', async () => {
  const f = fixture();
  f.commit('first');
  const tip = f.commit('second');
  const asked: Array<{ projectId: string; copied: unknown }> = [];
  const updated = Promise.withResolvers<void>();
  const copies = f.machineCopies({ updateBase: async (projectId, copied) => { asked.push({ projectId, copied }); updated.resolve(); return 'update-1'; } });
  const started = await copies.start('widgets', 'updateBase');
  expect(started).toMatchObject({ state: 'running', then: 'updateBase', updatedBase: null });
  await updated.promise;
  expect(asked).toEqual([{ projectId: 'widgets', copied: { baseBranch: 'main', previous: null, commit: tip } }]);
  expect(await finished(copies, started.operationId)).toMatchObject({ state: 'moved', commit: tip, updatedBase: { state: 'done', message: 'Update base is moving the base workspace (operation update-1)' } });
  // An account that refuses the update leaves the copy as it is, with the reason.
  const refusing = f.machineCopies({ updateBase: async () => { throw new Error('Commit or discard the base workspace changes first'); } });
  expect(await finished(refusing, (await refusing.start('widgets', 'updateBase')).operationId)).toMatchObject({ state: 'current', commit: tip, updatedBase: { state: 'failed', message: 'Commit or discard the base workspace changes first' } });
  // A copy started without it asks for nothing.
  expect(await f.copy()).toMatchObject({ state: 'current', then: null, updatedBase: null });
});

it('fails a copy that stops making progress, leaving nothing of a git cut short behind', async () => {
  const f = fixture();
  f.commit('first');
  await f.copy();
  f.commit('second');
  // A copy cut short by a killed machine left these.
  mkdirSync(join(f.machine, 'seed-old', 'repository'), { recursive: true });
  writeFileSync(join(f.cache, 'objects', 'pack', 'tmp_pack_cut'), 'partial');
  writeFileSync(join(f.cache, 'shallow.lock'), '');
  // The origin answers the listing, then goes silent on the fetch.
  const stall = join(f.root, 'stall.sh');
  writeFileSync(stall, `#!/bin/sh\nif [ -e "${f.root}/listed" ]; then exec sleep 30 2>/dev/null; fi\ntouch "${f.root}/listed"\nexec git "$1" "${f.origin}"\n`);
  chmodSync(stall, 0o755);
  const stalled = await f.copy({
    // The watchdog measures real time against a real silent git; a fake clock would not reach it.
    stallMs: 400,
    gitEnvironment: url => ({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: `url.ext::${stall} %s.insteadOf`, GIT_CONFIG_VALUE_0: url, GIT_CONFIG_KEY_1: 'protocol.ext.allow', GIT_CONFIG_VALUE_1: 'always' }),
  });
  expect(stalled).toMatchObject({ state: 'failed', phase: null, error: expect.stringContaining('No progress for 0 seconds while fetching from the origin') });
  expect(f.leftovers()).toEqual(['seed-old']);
  // The next machine start removes copies from before the cache.
  await f.machineCopies().resume();
  expect(f.leftovers()).toEqual([]);
  expect(await f.copy()).toMatchObject({ state: 'moved', fresh: null });
});

it('reports a failed git with git\'s own words', async () => {
  const f = fixture();
  f.commit('first');
  f.reach[ORIGIN_URL] = `file://${join(f.root, 'missing')}`;
  const failed = await f.copy();
  expect(failed).toMatchObject({ state: 'failed', phase: null });
  expect(failed.error).toContain('git ls-remote failed (exit 128).');
  expect(failed.error).toContain(`Git said: fatal: '${join(f.root, 'missing')}' does not appear to be a git repository`);
});

it('continues a copy a machine stop left running when the machine starts again', async () => {
  const f = fixture();
  const tip = f.commit('first');
  const stamp = new Date().toISOString();
  mkdirSync(join(f.machine, 'origins'), { recursive: true });
  await atomicJson(join(f.machine, 'origins', 'widgets.copy.json'), {
    operationId: 'copy-1', projectId: 'widgets', state: 'running', phase: 'fetching', progress: null, received: { objects: 0, bytes: 0 },
    fresh: null, filledFrom: null, baseBranch: 'main', previous: null, commit: null, error: null, then: null, updatedBase: null, startedAt: stamp, updatedAt: stamp,
  });
  const copies = f.machineCopies();
  await copies.resume();
  expect(await finished(copies, 'copy-1')).toMatchObject({ state: 'moved', previous: null, commit: tip, startedAt: stamp });
  expect(existsSync(join(f.machine, 'origins', 'widgets.copy.json'))).toBe(true);
  expect(await f.machineCopies().read('widgets', 'copy-1')).toMatchObject({ state: 'moved', commit: tip });
});
