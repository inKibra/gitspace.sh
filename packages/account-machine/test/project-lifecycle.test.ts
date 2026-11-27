import { afterEach, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactsGitRemote } from '../src/artifacts-git-remote.js';
import { seedProjectRepository } from '../src/project-lifecycle.js';

const ORIGIN_URL = 'https://github.com/acme-labs/widgets.git';
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

/** An origin this machine reaches over file://, and a bare repository standing in for the project's Artifacts
 * repository, reached at its HTTPS address. */
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
  const commit = (content: string) => {
    writeFileSync(join(origin, 'file'), content); git(origin, 'add', 'file'); git(origin, 'commit', '-qm', content);
    return git(origin, 'rev-parse', 'HEAD');
  };
  const scopes: string[] = [];
  /** A fresh remote holds no lease, so every credential it needs is requested and recorded. */
  const seed = () => seedProjectRepository({
    projectId: 'widgets', repositoryUrl: ORIGIN_URL, baseBranch: null, scratchRoot: root,
    gitEnvironment: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${origin}.insteadOf`, GIT_CONFIG_VALUE_0: ORIGIN_URL },
    projectRepository: new ArtifactsGitRemote({ credentials: async (_binding, scope) => {
      scopes.push(scope);
      return { remote: ARTIFACTS_URL, plaintext: 'offline', expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    } }),
  });
  const copied = () => git(artifacts, 'for-each-ref', '--format=%(refname) %(objectname)');
  return { root, origin, artifacts, commit, seed, scopes, copied };
}

it('fast-forwards a copy behind its origin, sending only the commits after it, with history linked', async () => {
  const f = fixture();
  const first = f.commit('first');
  const copiedAt = f.commit('second');
  expect(await f.seed()).toEqual({ baseBranch: 'main', previous: null, commit: copiedAt });
  expect(fails(f.artifacts, 'cat-file', '-e', first)).toBe(true);
  const before = new Set(git(f.artifacts, 'rev-list', '--objects', '--all').split('\n'));
  f.commit('third');
  const tip = f.commit('fourth');

  expect(await f.seed()).toEqual({ baseBranch: 'main', previous: copiedAt, commit: tip });
  expect(f.copied()).toBe(`refs/heads/main ${tip}`);
  // Linked: the copied tip's history reaches the commit the copy held, which stays its shallow end.
  git(f.artifacts, 'merge-base', '--is-ancestor', copiedAt, tip);
  expect(git(f.artifacts, 'rev-list', tip).split('\n')).toEqual(git(f.origin, 'rev-list', tip, '--not', first).split('\n'));
  expect(fails(f.artifacts, 'cat-file', '-e', first)).toBe(true);
  // Exactly the objects of the new commits arrived.
  const added = git(f.artifacts, 'rev-list', '--objects', '--all').split('\n').filter(line => !before.has(line)).map(line => line.split(' ')[0]).sort();
  expect(added).toEqual(git(f.origin, 'rev-list', '--objects', tip, '--not', copiedAt).split('\n').map(line => line.split(' ')[0]).sort());
});

it('refuses a copy at a commit outside its origin\'s history, naming both commits and leaving it where it was', async () => {
  const f = fixture();
  const first = f.commit('first');
  const copiedAt = f.commit('second');
  await f.seed();
  // The origin's main is rewritten; the copied commit stays reachable from another branch for now.
  git(f.origin, 'branch', 'kept', copiedAt);
  git(f.origin, 'reset', '-q', '--hard', first);
  const rewritten = f.commit('rewritten');
  const refusal = `The project's copy of main is at ${copiedAt.slice(0, 7)}, which origin's main (${rewritten.slice(0, 7)}) does not build on, so it was not moved: GitSpace only fast-forwards it.`;
  await expect(f.seed()).rejects.toThrow(refusal);
  expect(f.copied()).toBe(`refs/heads/main ${copiedAt}`);
  // Once the origin no longer holds the copied commit at all, the copy is refused the same way.
  git(f.origin, 'branch', '-D', 'kept');
  git(f.origin, 'reflog', 'expire', '--expire=now', '--all');
  git(f.origin, 'gc', '-q', '--prune=now');
  expect(fails(f.origin, 'cat-file', '-e', copiedAt)).toBe(true);
  await expect(f.seed()).rejects.toThrow(refusal);
  expect(f.copied()).toBe(`refs/heads/main ${copiedAt}`);
});

it('leaves a copy already at its origin\'s tip as it is, without writing', async () => {
  const f = fixture();
  f.commit('first');
  const tip = f.commit('second');
  await f.seed();
  f.scopes.splice(0);
  const hook = join(f.artifacts, 'hooks/pre-receive');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n'); chmodSync(hook, 0o755);
  expect(await f.seed()).toEqual({ baseBranch: 'main', previous: tip, commit: tip });
  expect(f.scopes).toEqual(['read']);
  expect(f.copied()).toBe(`refs/heads/main ${tip}`);
});
