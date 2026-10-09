import { afterEach, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactsBranchDivergedError, ArtifactsGitRemote } from '../src/artifacts-git-remote.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, env: { ...Bun.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.invalid' } });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-upload-')); roots.push(root);
  git(root, 'init', '-b', 'main');
  const remote = join(root, 'remote.git'); git(root, 'init', '--bare', remote);
  // receive-pack enforces the actual incoming pack byte limit, not estimated object sizes.
  git(remote, 'config', 'receive.maxInputSize', String(64 * 1024 * 1024));
  git(root, 'config', `url.${remote}.insteadOf`, 'https://artifacts.invalid/repository');
  const scopes: string[] = [];
  const publication = new ArtifactsGitRemote({ credentials: async (_binding, scope) => {
    scopes.push(scope);
    return { remote: 'https://artifacts.invalid/repository', plaintext: 'offline', expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  } });
  const checkpointRef = 'refs/gitspace/checkpoints/test';
  const publish = () => publication.publishCheckpoint({ repositoryPath: root, binding: { projectId: 'test', repository: 'test' }, checkpointRef });
  const publishBranch = (commit: string) => publication.publishBranch({ repositoryPath: root, binding: { projectId: 'test', repository: 'project-test' }, branch: 'main', commit });
  return { root, remote, checkpointRef, publication, publish, publishBranch, scopes };
}
function rejectPushes(remote: string) {
  const hook = join(remote, 'hooks/pre-receive');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n'); chmodSync(hook, 0o755);
}

it('publishes branch history larger than the receive limit in bounded packs without leaving upload refs', async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) {
    writeFileSync(join(f.root, `payload-${i}`), randomBytes(15 * 1024 * 1024));
    git(f.root, 'add', `payload-${i}`); git(f.root, 'commit', '-m', `payload ${i}`);
  }
  const commit = git(f.root, 'rev-parse', 'HEAD');
  await f.publishBranch(commit);
  expect(git(f.remote, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(`refs/heads/main ${commit}`);
  expect(git(f.remote, 'rev-list', '--parents', 'refs/heads/main')).toBe(git(f.root, 'rev-list', '--parents', commit));
  expect(git(f.remote, 'ls-tree', '-r', 'refs/heads/main')).toBe(git(f.root, 'ls-tree', '-r', commit));
}, 120_000);

it('treats a remote branch already at the commit as published without requesting write access', async () => {
  const f = fixture();
  writeFileSync(join(f.root, 'file'), 'seeded'); git(f.root, 'add', 'file'); git(f.root, 'commit', '-m', 'seeded');
  const commit = git(f.root, 'rev-parse', 'HEAD');
  git(f.root, 'push', f.remote, `${commit}:refs/heads/main`);
  rejectPushes(f.remote);
  await f.publishBranch(commit);
  expect(f.scopes).toEqual(['read']);
  expect(git(f.remote, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(`refs/heads/main ${commit}`);
});

it('refuses to move a remote branch that holds different history', async () => {
  const f = fixture();
  writeFileSync(join(f.root, 'file'), 'base'); git(f.root, 'add', 'file'); git(f.root, 'commit', '-m', 'base');
  const base = git(f.root, 'rev-parse', 'HEAD');
  git(f.root, 'push', f.remote, `${base}:refs/heads/main`);
  writeFileSync(join(f.root, 'file'), 'local'); git(f.root, 'commit', '-am', 'local');
  const local = git(f.root, 'rev-parse', 'HEAD');
  const refused = f.publishBranch(local);
  await expect(refused).rejects.toBeInstanceOf(ArtifactsBranchDivergedError);
  await expect(refused).rejects.toMatchObject({ branch: 'main', remoteCommit: base, commit: local });
  expect(git(f.remote, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(`refs/heads/main ${base}`);
  expect(f.scopes).toEqual(['read']);
});
for (const singleCommit of [false, true]) it(`publishes bounded packs preserving ${singleCommit ? 'an oversized single commit' : 'oversized history'} and local state`, async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) {
    writeFileSync(join(f.root, `payload-${i}`), randomBytes(15 * 1024 * 1024));
    git(f.root, 'add', `payload-${i}`);
    if (!singleCommit) git(f.root, 'commit', '-m', `payload ${i}`);
  }
  if (singleCommit) git(f.root, 'commit', '-m', 'all payloads');
  const commit = git(f.root, 'rev-parse', 'HEAD');
  git(f.root, 'update-ref', f.checkpointRef, commit);
  writeFileSync(join(f.root, 'staged'), 'staged'); git(f.root, 'add', 'staged');
  writeFileSync(join(f.root, 'staged'), 'worktree differs');
  const index = readFileSync(join(f.root, '.git/index'));
  const refs = git(f.root, 'show-ref');
  const hook = join(f.root, '.git/hooks/pre-push'); writeFileSync(hook, '#!/bin/sh\nexit 99\n'); chmodSync(hook, 0o755);
  await f.publish();
  expect(git(f.remote, 'rev-parse', f.checkpointRef)).toBe(commit);
  expect(git(f.remote, 'rev-list', '--parents', f.checkpointRef)).toBe(git(f.root, 'rev-list', '--parents', commit));
  expect(git(f.remote, 'ls-tree', '-r', f.checkpointRef)).toBe(git(f.root, 'ls-tree', '-r', commit));
  expect(git(f.remote, 'for-each-ref', '--format=%(refname)', 'refs/gitspace/upload/')).toBe('');
  expect(git(f.root, 'show-ref')).toBe(refs);
  expect(readFileSync(join(f.root, '.git/index')).equals(index)).toBe(true);
  expect(readFileSync(join(f.root, 'staged'), 'utf8')).toBe('worktree differs');
}, 120_000);

it('refuses blobs over 32 MB by path and size before publishing any ref', async () => {
  const f = fixture(); const size = 32_000_001;
  writeFileSync(join(f.root, 'too-large.bin'), Buffer.alloc(size)); git(f.root, 'add', 'too-large.bin'); git(f.root, 'commit', '-m', 'oversized');
  git(f.root, 'update-ref', f.checkpointRef, 'HEAD');
  await expect(f.publish()).rejects.toThrow(/too-large\.bin.*32000001.*32000000/);
  expect(git(f.remote, 'for-each-ref', '--format=%(refname)')).toBe('');
}, 120_000);

it('cleans only its own upload after rejection and retries a shared-object merge without changing history', async () => {
  const f = fixture();
  writeFileSync(join(f.root, 'base'), 'shared'); git(f.root, 'add', 'base'); git(f.root, 'commit', '-m', 'base');
  const base = git(f.root, 'rev-parse', 'HEAD');
  git(f.root, 'push', f.remote, `${base}:refs/gitspace/upload/foreign`);
  for (let i = 0; i < 5; i++) writeFileSync(join(f.root, `large-${i}`), randomBytes(15 * 1024 * 1024));
  for (const directory of ['nested-one', 'nested-two']) {
    mkdirSync(join(f.root, directory));
    for (let i = 0; i < 150; i++) writeFileSync(join(f.root, directory, `entry-${i}`), `shared nested object ${i}`);
  }
  git(f.root, 'add', 'large-0', 'large-1', 'large-2', 'large-3', 'large-4', 'nested-one', 'nested-two');
  git(f.root, 'commit', '-m', 'large shared trees');
  git(f.root, 'checkout', '-b', 'side');
  writeFileSync(join(f.root, 'side'), 'shared'); git(f.root, 'add', 'side'); git(f.root, 'commit', '-m', 'side');
  git(f.root, 'checkout', 'main');
  writeFileSync(join(f.root, 'main'), 'shared'); git(f.root, 'add', 'main'); git(f.root, 'commit', '-m', 'main');
  git(f.root, 'merge', '--no-ff', 'side', '-m', 'merge');
  const commit = git(f.root, 'rev-parse', 'HEAD'); git(f.root, 'update-ref', f.checkpointRef, commit);
  const hook = join(f.remote, 'hooks/pre-receive');
  writeFileSync(hook, `#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = "${f.checkpointRef}" ] && [ ! -f accepted-once ]; then\n    touch accepted-once\n    exit 1\n  fi\ndone\n`);
  chmodSync(hook, 0o755);
  await expect(f.publish()).rejects.toThrow();
  expect(git(f.remote, 'for-each-ref', '--format=%(refname)', 'refs/gitspace/upload/')).toBe('refs/gitspace/upload/foreign');
  await f.publish();
  expect(git(f.remote, 'rev-list', '--parents', f.checkpointRef)).toBe(git(f.root, 'rev-list', '--parents', commit));
  expect(git(f.remote, 'ls-tree', '-r', f.checkpointRef)).toBe(git(f.root, 'ls-tree', '-r', commit));
  expect(git(f.remote, 'for-each-ref', '--format=%(refname)', 'refs/gitspace/upload/')).toBe('refs/gitspace/upload/foreign');
}, 120_000);

it('anchors a shared canonical checkpoint ref at the newest tip received, never rewinding to an older one', async () => {
  const f = fixture();
  // The cloud advances one canonical ref per workspace for every cache: x1 <- x2 <- x3.
  const canonical = 'refs/gitspace/spaces/space/checkpoints';
  const commit = (content: string) => {
    writeFileSync(join(f.root, 'file'), content); git(f.root, 'add', 'file'); git(f.root, 'commit', '-m', content);
    return git(f.root, 'rev-parse', 'HEAD');
  };
  const x1 = commit('x1'), x2 = commit('x2'), x3 = commit('x3');
  git(f.root, 'push', f.remote, `${x3}:${canonical}`);
  const cache = join(f.root, 'cache');
  git(f.root, 'init', '-b', 'main', cache);
  git(cache, 'config', `url.${f.remote}.insteadOf`, 'https://artifacts.invalid/repository');
  const fetch = (tip: string) => f.publication.fetchCheckpoint({ repositoryPath: cache, binding: { projectId: 'test', repository: 'test' }, checkpointRef: canonical, commit: tip });
  const anchor = () => git(cache, 'for-each-ref', '--format=%(objectname)', canonical);
  await fetch(x2);
  expect(anchor()).toBe(x2);
  await fetch(x3);
  expect(anchor()).toBe(x3);
  // A long-poll or dispatch snapshot overtaken by this cache's own publication is a no-op.
  await fetch(x1);
  await fetch(x2);
  expect(anchor()).toBe(x3);
  // A replaced canonical history (recreated repository) is followed, not refused forever.
  git(f.root, 'checkout', '--orphan', 'replaced');
  const y1 = commit('y1');
  git(f.root, 'push', '--force', f.remote, `${y1}:${canonical}`);
  await fetch(y1);
  expect(anchor()).toBe(y1);
  expect(git(cache, 'for-each-ref', '--format=%(refname)', 'refs/gitspace/')).toBe(canonical);
});
