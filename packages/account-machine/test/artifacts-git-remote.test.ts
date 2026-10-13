import { afterEach, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactsBranchDivergedError, ArtifactsGitRemote, ArtifactsRepositoryIncompatibleError, ArtifactsUploadLimitError, verifyArtifactsGitUpload } from '../src/artifacts-git-remote.js';
import { createGitIntermediateCheckpoint, restoreGitIntermediateCheckpoint } from '../src/git-checkpoint.js';
import { acquireCheckout } from '../../runtime-machine/src/artifactfs.js';

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
  git(remote, 'config', 'receive.shallowUpdate', 'true');
  git(root, 'config', `url.${remote}.insteadOf`, 'https://artifacts.invalid/repository');
  const scopes: string[] = [];
  const publication = new ArtifactsGitRemote({ credentials: async (_binding, scope) => {
    scopes.push(scope);
    return { remote: 'https://artifacts.invalid/repository', plaintext: 'offline', expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  } });
  const checkpointRef = 'refs/gitspace/checkpoints/test';
  const publish = (headCommit: string | null = git(root, 'rev-parse', 'HEAD')) => publication.publishCheckpoint({ repositoryPath: root, binding: { projectId: 'test', repository: 'test' }, checkpointRef, headCommit });
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
  const objects = git(f.root, 'count-objects', '-v');
  const hook = join(f.root, '.git/hooks/pre-push'); writeFileSync(hook, '#!/bin/sh\nexit 99\n'); chmodSync(hook, 0o755);
  const preflight = join(f.root, 'preflight.git');
  git(f.root, 'clone', '--mirror', '--no-local', f.root, preflight);
  await verifyArtifactsGitUpload(preflight, commit, commit);
  expect(git(preflight, 'for-each-ref', '--format=%(refname)', 'refs/gitspace/upload/')).toBe('');
  expect(git(f.remote, 'for-each-ref', '--format=%(refname)')).toBe('');
  await f.publish();
  expect(git(f.remote, 'rev-parse', f.checkpointRef)).toBe(commit);
  expect(git(f.remote, 'rev-list', '--parents', f.checkpointRef)).toBe(git(f.root, 'rev-list', '--parents', commit));
  expect(git(f.remote, 'ls-tree', '-r', f.checkpointRef)).toBe(git(f.root, 'ls-tree', '-r', commit));
  expect(git(f.remote, 'for-each-ref', '--format=%(refname)', 'refs/gitspace/upload/')).toBe('');
  expect(git(f.root, 'show-ref')).toBe(refs);
  expect(git(f.root, 'count-objects', '-v')).toBe(objects);
  expect(readFileSync(join(f.root, '.git/index')).equals(index)).toBe(true);
  expect(readFileSync(join(f.root, 'staged'), 'utf8')).toBe('worktree differs');
}, 120_000);

it('publishes a blob at the exact decimal 32 MB boundary', async () => {
  const f = fixture();
  writeFileSync(join(f.root, 'boundary.bin'), Buffer.alloc(32_000_000));
  git(f.root, 'add', 'boundary.bin'); git(f.root, 'commit', '-m', 'boundary');
  const commit = git(f.root, 'rev-parse', 'HEAD');
  git(f.root, 'update-ref', f.checkpointRef, commit);
  await f.publishBranch(commit);
  await f.publish();
  expect(git(f.remote, 'cat-file', '-s', `${commit}:boundary.bin`)).toBe('32000000');
  expect(git(f.remote, 'rev-parse', 'refs/heads/main')).toBe(commit);
  expect(git(f.remote, 'rev-parse', f.checkpointRef)).toBe(commit);
}, 120_000);

it('rejects current oversized blobs before credentials, preserving every local and published ref', async () => {
  const f = fixture();
  writeFileSync(join(f.root, 'base'), 'good');
  git(f.root, 'add', 'base'); git(f.root, 'commit', '-m', 'good checkpoint');
  const good = git(f.root, 'rev-parse', 'HEAD');
  git(f.root, 'push', f.remote, `${good}:${f.checkpointRef}`);
  const renamed = 'renamed \tcurrent\n.bin';
  writeFileSync(join(f.root, 'original.bin'), Buffer.alloc(32_000_001));
  writeFileSync(join(f.root, 'deleted.bin'), Buffer.alloc(32_000_002, 1));
  git(f.root, 'add', 'original.bin', 'deleted.bin'); git(f.root, 'commit', '-m', 'oversized history');
  const originalOid = git(f.root, 'rev-parse', 'HEAD:original.bin');
  git(f.root, 'mv', 'original.bin', renamed); git(f.root, 'rm', 'deleted.bin');
  git(f.root, 'commit', '-m', 'rename and delete');
  const commit = git(f.root, 'rev-parse', 'HEAD');
  git(f.root, 'update-ref', f.checkpointRef, commit);
  writeFileSync(join(f.root, 'base'), 'staged');
  git(f.root, 'add', 'base');
  writeFileSync(join(f.root, 'base'), 'unstaged');
  writeFileSync(join(f.root, 'untracked'), 'retained');
  const index = readFileSync(join(f.root, '.git/index'));
  const status = git(f.root, 'status', '--porcelain=v1', '-z');
  const refs = git(f.root, 'show-ref');
  const objects = git(f.root, 'count-objects', '-v');
  const published = git(f.remote, 'show-ref');
  for (const publish of [f.publish, () => f.publishBranch(commit)]) {
    const rejection = publish();
    await expect(rejection).rejects.toBeInstanceOf(ArtifactsRepositoryIncompatibleError);
    try { await rejection; } catch (error) {
      if (!(error instanceof ArtifactsRepositoryIncompatibleError)) throw error;
      expect(error.code).toBe('ARTIFACTS_REPOSITORY_INCOMPATIBLE');
      expect(error.retryable).toBe(false);
      expect(error.issues).toEqual([{ oid: originalOid, path: renamed, size: 32_000_001, location: 'current' }]);
    }
  }
  expect(f.scopes).toEqual([]);
  expect(git(f.remote, 'show-ref')).toBe(published);
  expect(git(f.root, 'show-ref')).toBe(refs);
  expect(git(f.root, 'count-objects', '-v')).toBe(objects);
  expect(git(f.root, 'status', '--porcelain=v1', '-z')).toBe(status);
  expect(readFileSync(join(f.root, '.git/index')).equals(index)).toBe(true);
  expect(readFileSync(join(f.root, 'base'), 'utf8')).toBe('unstaged');
  expect(readFileSync(join(f.root, 'untracked'), 'utf8')).toBe('retained');
}, 120_000);

it('rejects an indivisible commit exceeding the pack limit before any credentials or remote writes', async () => {
  const f = fixture();
  git(f.root, 'commit', '--allow-empty', '-m', 'good');
  const good = git(f.root, 'rev-parse', 'HEAD');
  git(f.root, 'push', f.remote, `${good}:${f.checkpointRef}`);
  const tree = git(f.root, 'rev-parse', 'HEAD^{tree}');
  const content = `tree ${tree}\nparent ${good}\nauthor Test <test@test.invalid> 1 +0000\ncommitter Test <test@test.invalid> 1 +0000\n\n${'x'.repeat(48 * 1024 * 1024)}\n`;
  const child = Bun.spawn(['git', 'hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: f.root, stdin: new Blob([content]), stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, output, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(stderr);
  const commit = output.trim();
  git(f.root, 'update-ref', f.checkpointRef, commit);
  const refs = git(f.root, 'show-ref');
  const objects = git(f.root, 'count-objects', '-v');
  await expect(f.publish()).rejects.toBeInstanceOf(ArtifactsUploadLimitError);
  expect(f.scopes).toEqual([]);
  expect(git(f.root, 'show-ref')).toBe(refs);
  expect(git(f.root, 'count-objects', '-v')).toBe(objects);
  expect(git(f.remote, 'rev-parse', f.checkpointRef)).toBe(good);
  expect(git(f.remote, 'for-each-ref', '--format=%(refname)', 'refs/gitspace/upload/')).toBe('');
}, 120_000);

it('publishes only the immutable checkpoint preflighted before credentials even if its local ref advances', async () => {
  const f = fixture();
  writeFileSync(join(f.root, 'file'), 'good');
  git(f.root, 'add', 'file'); git(f.root, 'commit', '-m', 'good');
  const good = git(f.root, 'rev-parse', 'HEAD');
  git(f.root, 'update-ref', f.checkpointRef, good);
  writeFileSync(join(f.root, 'oversized.bin'), Buffer.alloc(32_000_001));
  git(f.root, 'add', 'oversized.bin'); git(f.root, 'commit', '-m', 'unchecked next checkpoint');
  const unchecked = git(f.root, 'rev-parse', 'HEAD');
  const publication = new ArtifactsGitRemote({ credentials: async () => {
    git(f.root, 'update-ref', f.checkpointRef, unchecked, good);
    return { remote: 'https://artifacts.invalid/repository', plaintext: 'offline', expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  } });
  await publication.publishCheckpoint({ repositoryPath: f.root, binding: { projectId: 'test', repository: 'test' }, checkpointRef: f.checkpointRef, headCommit: good });
  expect(git(f.remote, 'rev-parse', f.checkpointRef)).toBe(good);
  expect(git(f.root, 'rev-parse', f.checkpointRef)).toBe(unchecked);
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

for (const layer of ['HEAD', 'index', 'tracked', 'portable'] as const) it(`rejects an oversized ${layer} layer even when later layers omit it`, async () => {
  const f = fixture();
  writeFileSync(join(f.root, 'asset.bin'), 'small');
  git(f.root, 'add', 'asset.bin'); git(f.root, 'commit', '-m', 'good');
  const good = git(f.root, 'rev-parse', 'HEAD');
  git(f.root, 'push', f.remote, `${good}:${f.checkpointRef}`);
  const path = layer === 'portable' ? 'portable.bin' : 'asset.bin';
  writeFileSync(join(f.root, path), Buffer.alloc(32_000_001));
  if (layer === 'HEAD' || layer === 'index') git(f.root, 'add', path);
  if (layer === 'HEAD') {
    git(f.root, 'commit', '-m', 'oversized current HEAD');
    git(f.root, 'rm', path);
  } else if (layer === 'index') rmSync(join(f.root, path));
  const checkpoint = await createGitIntermediateCheckpoint({ repositoryPath: f.root, spaceId: 'layers', revision: 1, portableUntrackedPaths: layer === 'portable' ? [path] : [] });
  // A later tree cannot sanitize a required middle layer.
  const tip = layer === 'tracked'
    ? git(f.root, 'commit-tree', `${good}^{tree}`, '-p', checkpoint.trackedWorktreeCommit, '-m', 'later omission')
    : checkpoint.worktreeCommit;
  git(f.root, 'update-ref', f.checkpointRef, tip);
  const refs = git(f.root, 'show-ref'), index = readFileSync(join(f.root, '.git/index'));
  const rejected = f.publish(checkpoint.headCommit);
  await expect(rejected).rejects.toMatchObject({ code: 'ARTIFACTS_REPOSITORY_INCOMPATIBLE', issues: expect.arrayContaining([expect.objectContaining({ path, size: 32_000_001, location: 'current' })]) });
  expect(f.scopes).toEqual([]);
  expect(git(f.remote, 'rev-parse', f.checkpointRef)).toBe(good);
  expect(git(f.root, 'show-ref')).toBe(refs);
  expect(readFileSync(join(f.root, '.git/index'))).toEqual(index);
}, 120_000);

for (const shallowSource of [false, true]) it(`publishes a bounded historical fallback from a ${shallowSource ? 'shallow' : 'full'} source without changing its graph`, async () => {
  const f = fixture();
  git(f.root, 'commit', '--allow-empty', '-m', 'root');
  const rootCommit = git(f.root, 'rev-parse', 'HEAD');
  writeFileSync(join(f.root, 'old.bin'), Buffer.alloc(32_000_001));
  git(f.root, 'add', 'old.bin'); git(f.root, 'commit', '-m', 'oversized history');
  const oldBlob = git(f.root, 'rev-parse', 'HEAD:old.bin');
  git(f.root, 'rm', 'old.bin'); git(f.root, 'commit', '-m', 'compatible HEAD');
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(f.root, `current-${i}.bin`), Buffer.alloc(17_000_000, i));
    git(f.root, 'add', `current-${i}.bin`);
  }
  git(f.root, 'commit', '-m', 'bounded current tree');
  git(f.root, 'checkout', '-b', 'side');
  writeFileSync(join(f.root, 'side'), 'side'); git(f.root, 'add', 'side'); git(f.root, 'commit', '-m', 'side');
  git(f.root, 'checkout', 'main');
  writeFileSync(join(f.root, 'main'), 'main'); git(f.root, 'add', 'main'); git(f.root, 'commit', '-m', 'main');
  git(f.root, 'merge', '--no-ff', 'side', '-m', 'merge');
  const head = git(f.root, 'rev-parse', 'HEAD');
  if (shallowSource) writeFileSync(join(f.root, '.git/shallow'), `${rootCommit}\n`);
  git(f.root, 'update-ref', f.checkpointRef, head);
  const index = readFileSync(join(f.root, '.git/index')), config = readFileSync(join(f.root, '.git/config'));
  const refs = git(f.root, 'show-ref'), objects = git(f.root, 'count-objects', '-v'), history = git(f.root, 'rev-list', '--parents', head);
  await verifyArtifactsGitUpload(f.root, head, head);
  await f.publish();
  expect(git(f.remote, 'rev-parse', f.checkpointRef)).toBe(head);
  expect(git(f.remote, 'rev-list', f.checkpointRef)).toBe(head);
  expect(git(f.remote, 'ls-tree', '-r', head)).toBe(git(f.root, 'ls-tree', '-r', head));
  expect(Bun.spawnSync(['git', 'cat-file', '-e', oldBlob], { cwd: f.remote }).exitCode).not.toBe(0);
  expect(git(f.remote, 'for-each-ref', '--format=%(refname)')).toBe(f.checkpointRef);
  expect(git(f.root, 'show-ref')).toBe(refs);
  expect(git(f.root, 'count-objects', '-v')).toBe(objects);
  expect(git(f.root, 'rev-list', '--parents', head)).toBe(history);
  expect(readFileSync(join(f.root, '.git/index'))).toEqual(index);
  expect(readFileSync(join(f.root, '.git/config'))).toEqual(config);
  expect(existsSync(join(f.root, '.git/shallow'))).toBe(shallowSource);
  if (shallowSource) expect(readFileSync(join(f.root, '.git/shallow'), 'utf8')).toBe(`${rootCommit}\n`);
}, 120_000);

it('materializes and restores a shallow checkpoint, preserves full caches, and can deepen through origin', async () => {
  const f = fixture();
  writeFileSync(join(f.root, 'old.bin'), Buffer.alloc(32_000_001));
  git(f.root, 'add', 'old.bin'); git(f.root, 'commit', '-m', 'old oversized root');
  const old = git(f.root, 'rev-parse', 'HEAD');
  git(f.root, 'rm', 'old.bin');
  writeFileSync(join(f.root, 'tracked'), 'HEAD bytes');
  git(f.root, 'add', 'tracked'); git(f.root, 'commit', '-m', 'current');
  writeFileSync(join(f.root, 'tracked'), 'index bytes'); git(f.root, 'add', 'tracked');
  writeFileSync(join(f.root, 'tracked'), 'worktree bytes');
  writeFileSync(join(f.root, 'portable'), 'portable bytes');
  const checkpoint = await createGitIntermediateCheckpoint({ repositoryPath: f.root, spaceId: 'restore', revision: 1, portableUntrackedPaths: ['portable'] });
  await f.publication.publishCheckpoint({ repositoryPath: f.root, binding: { projectId: 'test', repository: 'test' }, checkpointRef: checkpoint.checkpointRef, headCommit: checkpoint.headCommit });
  const cache = join(f.root, 'cold-cache');
  await acquireCheckout({
    name: 'cold-cache', directory: cache, source: { remote: 'https://artifacts.invalid/repository', ref: checkpoint.checkpointRef, commit: checkpoint.worktreeCommit },
    fixed: true, requiresFiltersOrSubmodules: false, signal: new AbortController().signal, hydrateLfs: async () => {},
    host: { root: f.root, ensureDaemon: async () => { throw new Error('Git acquisition must not start a daemon'); }, gitEnvironment: async () => ({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${f.remote}.insteadOf`, GIT_CONFIG_VALUE_0: 'https://artifacts.invalid/repository' }) },
  });
  await restoreGitIntermediateCheckpoint({ repositoryPath: cache, checkpoint, branch: 'main' });
  expect(git(cache, 'rev-parse', 'HEAD')).toBe(checkpoint.headCommit!);
  expect(git(cache, 'show', ':tracked')).toBe('index bytes');
  expect(readFileSync(join(cache, 'tracked'), 'utf8')).toBe('worktree bytes');
  expect(readFileSync(join(cache, 'portable'), 'utf8')).toBe('portable bytes');
  expect(git(cache, 'rev-list', 'HEAD')).toBe(checkpoint.headCommit!);
  const full = join(f.root, 'full-cache');
  git(f.root, 'clone', '--no-local', f.root, full);
  git(full, 'config', `url.${f.remote}.insteadOf`, 'https://artifacts.invalid/repository');
  await f.publication.fetchCheckpoint({ repositoryPath: full, binding: { projectId: 'test', repository: 'test' }, checkpointRef: checkpoint.checkpointRef, commit: checkpoint.worktreeCommit });
  expect(git(full, 'rev-parse', '--is-shallow-repository')).toBe('false');
  expect(git(full, 'rev-parse', 'HEAD^')).toBe(old);
  expect(git(full, 'rev-parse', checkpoint.checkpointRef)).toBe(checkpoint.worktreeCommit);
  // A new local commit on a truly shallow source retains its older boundary.
  git(cache, 'commit', '-m', 'new work after cold restore');
  git(cache, 'config', `url.${f.remote}.insteadOf`, 'https://artifacts.invalid/repository');
  const next = await createGitIntermediateCheckpoint({ repositoryPath: cache, spaceId: 'restore', revision: 2, portableUntrackedPaths: ['portable'] });
  const boundary = readFileSync(join(cache, '.git/shallow'));
  await f.publication.publishCheckpoint({ repositoryPath: cache, binding: { projectId: 'test', repository: 'test' }, checkpointRef: next.checkpointRef, headCommit: next.headCommit });
  expect(readFileSync(join(cache, '.git/shallow'))).toEqual(boundary);
  expect(git(f.remote, 'rev-parse', `${next.headCommit}^`)).toBe(checkpoint.headCommit!);
  await f.publication.fetchCheckpoint({ repositoryPath: full, binding: { projectId: 'test', repository: 'test' }, checkpointRef: next.checkpointRef, commit: next.worktreeCommit });
  expect(git(full, 'rev-parse', '--is-shallow-repository')).toBe('false');
  expect(git(full, 'rev-parse', `${next.headCommit}^^`)).toBe(old);
  git(cache, 'remote', 'set-url', 'origin', f.root);
  git(cache, 'fetch', '--unshallow', 'origin');
  expect(git(cache, 'rev-parse', '--is-shallow-repository')).toBe('false');
  expect(git(cache, 'rev-parse', 'HEAD^^')).toBe(old);
  expect(git(cache, 'show', ':tracked')).toBe('index bytes');
  expect(readFileSync(join(cache, 'tracked'), 'utf8')).toBe('worktree bytes');
}, 120_000);

it('publishes and restores a genuinely unborn snapshot with no shallow boundary', async () => {
  const f = fixture();
  writeFileSync(join(f.root, 'staged'), 'index');
  git(f.root, 'add', 'staged');
  writeFileSync(join(f.root, 'staged'), 'worktree');
  const checkpoint = await createGitIntermediateCheckpoint({ repositoryPath: f.root, spaceId: 'unborn', revision: 1, portableUntrackedPaths: [] });
  await verifyArtifactsGitUpload(f.root, checkpoint.worktreeCommit, null);
  await f.publication.publishCheckpoint({ repositoryPath: f.root, binding: { projectId: 'test', repository: 'test' }, checkpointRef: checkpoint.checkpointRef, headCommit: null });
  const cache = join(f.root, 'cache'); git(f.root, 'init', '-b', 'main', cache);
  git(cache, 'config', `url.${f.remote}.insteadOf`, 'https://artifacts.invalid/repository');
  await f.publication.fetchCheckpoint({ repositoryPath: cache, binding: { projectId: 'test', repository: 'test' }, checkpointRef: checkpoint.checkpointRef });
  await restoreGitIntermediateCheckpoint({ repositoryPath: cache, checkpoint, branch: 'main' });
  expect(git(cache, 'rev-parse', '--is-shallow-repository')).toBe('false');
  expect(Bun.spawnSync(['git', 'rev-parse', '--verify', 'HEAD'], { cwd: cache }).exitCode).not.toBe(0);
  expect(git(cache, 'show', ':staged')).toBe('index');
  expect(readFileSync(join(cache, 'staged'), 'utf8')).toBe('worktree');
});

it('rejects an oversized unborn index hidden by a worktree deletion before credentials', async () => {
  const f = fixture();
  writeFileSync(join(f.root, 'large.bin'), Buffer.alloc(32_000_001));
  git(f.root, 'add', 'large.bin'); rmSync(join(f.root, 'large.bin'));
  const checkpoint = await createGitIntermediateCheckpoint({ repositoryPath: f.root, spaceId: 'unborn-large', revision: 1, portableUntrackedPaths: [] });
  const rejected = f.publication.publishCheckpoint({ repositoryPath: f.root, binding: { projectId: 'test', repository: 'test' }, checkpointRef: checkpoint.checkpointRef, headCommit: null });
  await expect(rejected).rejects.toMatchObject({ code: 'ARTIFACTS_REPOSITORY_INCOMPATIBLE', issues: expect.arrayContaining([expect.objectContaining({ path: 'large.bin', location: 'current' })]) });
  expect(f.scopes).toEqual([]);
  expect(git(f.root, 'cat-file', '-s', ':large.bin')).toBe('32000001');
}, 120_000);

it('does not let a source shallow marker conceal required snapshot layers', async () => {
  const f = fixture();
  git(f.root, 'commit', '--allow-empty', '-m', 'HEAD');
  const checkpoint = await createGitIntermediateCheckpoint({ repositoryPath: f.root, spaceId: 'required', revision: 1, portableUntrackedPaths: [] });
  writeFileSync(join(f.root, '.git/shallow'), `${checkpoint.worktreeCommit}\n`);
  rmSync(join(f.root, '.git/objects', checkpoint.indexCommit.slice(0, 2), checkpoint.indexCommit.slice(2)));
  const rejected = f.publication.publishCheckpoint({ repositoryPath: f.root, binding: { projectId: 'test', repository: 'test' }, checkpointRef: checkpoint.checkpointRef, headCommit: checkpoint.headCommit });
  await expect(rejected).rejects.toThrow();
  expect(f.scopes).toEqual([]);
  expect(readFileSync(join(f.root, '.git/shallow'), 'utf8')).toBe(`${checkpoint.worktreeCommit}\n`);
});
