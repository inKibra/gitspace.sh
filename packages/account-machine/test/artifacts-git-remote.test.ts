import { afterEach, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactsGitRemote } from '../src/artifacts-git-remote.js';

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
  const publication = new ArtifactsGitRemote({ credentials: async () => ({ remote: 'https://artifacts.invalid/repository', plaintext: 'offline', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }) });
  const checkpointRef = 'refs/gitspace/checkpoints/test';
  const publish = () => publication.publishCheckpoint({ repositoryPath: root, binding: { projectId: 'test', repository: 'test' }, checkpointRef });
  return { root, remote, checkpointRef, publish };
}
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
