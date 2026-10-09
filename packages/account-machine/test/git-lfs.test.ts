import { afterEach, expect, it, spyOn } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { collectBytes, confirmGitLfsObjects, GitLfsObjectSchema, type GitLfsOriginConfirmation, type GitLfsStore } from '@gitspace/protocol-workspace';
import { createGitIntermediateCheckpoint, restoreGitIntermediateCheckpoint, applyGitCacheCheckpoint, IncrementalGitSnapshots, type GitIntermediateCheckpoint } from '../src/git-checkpoint.js';
import { recheckGitLfsOrigin, restoredGitLfsPaths } from '../src/git-lfs.js';
import { ArtifactsGitRemote } from '../src/artifacts-git-remote.js';
import { committedLfsInventory } from '../src/git-lfs-inventory.js';
const fetchImplementation = (implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) => Object.assign(implementation, { preconnect: fetch.preconnect });

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd: root, env: { ...Bun.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.invalid' } });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-lfs-')); roots.push(root);
  git(root, 'init', '-b', 'main');
  // Real Git pointer trees and real cache layout; no provider or git-lfs binary is needed.
  git(root, 'config', 'filter.lfs.process', ''); git(root, 'config', 'filter.lfs.clean', 'cat'); git(root, 'config', 'filter.lfs.smudge', 'cat'); git(root, 'config', 'filter.lfs.required', 'false');
  writeFileSync(join(root, '.gitattributes'), '*.bin filter=lfs\n');
  const objects = new Map<string, Uint8Array>(); const uploads: string[] = [];
  const store: GitLfsStore = {
    has: async object => objects.has(object.oid),
    get: async object => { const bytes = objects.get(object.oid); return bytes ? (async function* () { yield bytes; })() : null; },
    put: async (object, source) => { uploads.push(object.oid); objects.set(object.oid, await collectBytes(source, object.size)); },
  };
  const lfs = { store, originEnvironment: async () => ({ GIT_TERMINAL_PROMPT: '0' }) };
  function pointer(value: string) {
    const bytes = new TextEncoder().encode(value); const object = GitLfsObjectSchema.parse({ oid: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
    const cache = join(root, '.git/lfs/objects', object.oid.slice(0, 2), object.oid.slice(2, 4)); mkdirSync(cache, { recursive: true }); writeFileSync(join(cache, object.oid), bytes);
    return { object, bytes, text: `version https://git-lfs.github.com/spec/v1\noid sha256:${object.oid}\nsize ${object.size}\n` };
  }
  const base = pointer('committed bytes'); writeFileSync(join(root, 'asset.bin'), base.text); git(root, 'add', '.'); git(root, 'commit', '-m', 'base');
  const capture = (revision: number) => createGitIntermediateCheckpoint({ repositoryPath: root, spaceId: 'space', revision, lfs });
  return { root, base, pointer, lfs, uploads, objects, capture };
}

it('applies committed LFS deltas to hydrated caches without replacing later held-back bytes', async () => {
  const f = fixture();
  const base = await f.capture(1);
  const target = mkdtempSync(join(tmpdir(), 'gitspace-lfs-cache-')); roots.push(target);
  git(target, 'init', '-b', 'main');
  git(target, 'fetch', f.root, `${base.checkpointRef}:${base.checkpointRef}`);
  await restoreGitIntermediateCheckpoint({ repositoryPath: target, checkpoint: base, branch: 'main', lfs: f.lfs });
  const next = f.pointer('new committed payload');
  writeFileSync(join(f.root, 'asset.bin'), next.text);
  git(f.root, 'add', 'asset.bin'); git(f.root, 'commit', '-m', 'new payload');
  const incoming = await f.capture(2);
  git(target, 'fetch', f.root, `${incoming.checkpointRef}:${incoming.checkpointRef}`);
  await applyGitCacheCheckpoint({ repositoryPath: target, previous: base, checkpoint: incoming, lfs: f.lfs });
  expect(readFileSync(join(target, 'asset.bin'), 'utf8')).toBe('new committed payload');
  expect(git(target, 'write-tree')).toBe(incoming.indexTree);
  if (incoming.headCommit === null) throw new Error('Committed LFS fixture lost HEAD');
  expect(git(target, 'rev-parse', 'HEAD')).toBe(incoming.headCommit);
  writeFileSync(join(target, 'asset.bin'), 'private newer bytes');
  const held = await createGitIntermediateCheckpoint({ repositoryPath: target, spaceId: 'cache', revision: 3, lfs: f.lfs });
  await applyGitCacheCheckpoint({ repositoryPath: target, previous: held, checkpoint: incoming, lfs: f.lfs });
  expect(readFileSync(join(target, 'asset.bin'), 'utf8')).toBe('private newer bytes');
  expect(f.uploads).not.toContain(createHash('sha256').update('private newer bytes').digest('hex'));
});

it('holds edited and staged payloads using HEAD nested attributes without touching local state', async () => {
  const f = fixture(); mkdirSync(join(f.root, 'nested')); writeFileSync(join(f.root, 'nested/.gitattributes'), '*.dat filter=lfs\n'); writeFileSync(join(f.root, 'nested/a.dat'), f.base.text); git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'nested');
  writeFileSync(join(f.root, '.gitattributes'), '*.bin -filter\n'); writeFileSync(join(f.root, 'nested/.gitattributes'), '*.dat -filter\n');
  writeFileSync(join(f.root, 'asset.bin'), 'private edit'); writeFileSync(join(f.root, 'nested/a.dat'), 'private staged'); git(f.root, 'add', 'nested/a.dat');
  const index = readFileSync(join(f.root, '.git/index')); const status = git(f.root, 'status', '--porcelain');
  const checkpoint = await f.capture(1);
  expect(checkpoint.lfs?.heldBack).toEqual([{ path: 'asset.bin', kind: 'modified' }, { path: 'nested/a.dat', kind: 'staged' }]);
  expect(git(f.root, 'show', `${checkpoint.worktreeCommit}:asset.bin`)).toBe(f.base.text.trim());
  expect(git(f.root, 'show', `${checkpoint.indexCommit}:nested/a.dat`)).toBe(f.base.text.trim());
  expect(git(f.root, 'show', `${checkpoint.worktreeCommit}:.gitattributes`)).toBe('*.bin -filter');
  expect(readFileSync(join(f.root, '.git/index'))).toEqual(index); expect(git(f.root, 'status', '--porcelain')).toBe(status);
  expect(f.uploads).toEqual([f.base.object.oid]);
});

it('only uploads committed objects, dedupes oids and retains history across deletion and rename', async () => {
  const f = fixture(); const next = f.pointer('next committed');
  writeFileSync(join(f.root, 'new.bin'), next.text); git(f.root, 'add', 'new.bin');
  const held = await f.capture(1); expect(held.lfs?.heldBack).toContainEqual({ path: 'new.bin', kind: 'staged' }); expect(f.uploads).toEqual([f.base.object.oid]);
  expect(git(f.root, 'ls-tree', held.worktreeCommit, 'new.bin')).toBe('');
  git(f.root, 'commit', '-m', 'next'); await f.capture(2); await f.capture(3); expect(f.uploads).toEqual([f.base.object.oid, next.object.oid]);
  git(f.root, 'mv', 'new.bin', 'renamed.bin'); git(f.root, 'rm', 'asset.bin'); git(f.root, 'commit', '-m', 'rename and delete');
  const final = await f.capture(4); expect(final.lfs?.objects.map(object => object.oid).sort()).toEqual([f.base.object.oid, next.object.oid].sort());
  expect(git(f.root, 'show', `${final.worktreeCommit}:renamed.bin`)).toBe(next.text.trim());
});

it('publishes heldBack transitions even when sanitized trees are identical', async () => {
  const f = fixture(); let revision = 0; let committed: GitIntermediateCheckpoint | null = null; const publications: GitIntermediateCheckpoint[] = [];
  const snapshots = new IncrementalGitSnapshots({ repositoryPath: f.root, spaceId: 'space', lfs: async () => f.lfs, allocateRevision: async () => ++revision, loadPending: async () => null, loadCommitted: async () => committed, savePending: async () => {}, publish: async value => { publications.push(value); }, commit: async value => { committed = value; return value; } });
  const clean = await snapshots.capture(); writeFileSync(join(f.root, 'asset.bin'), 'held edit'); const held = await snapshots.capture();
  expect(held.indexTree).toBe(clean.indexTree); expect(held.worktreeTree).toBe(clean.worktreeTree); expect(publications).toEqual([clean, held]);
});

it('hydrates R2 on handoff and rejects missing objects before changing the target checkout', async () => {
  const f = fixture(); writeFileSync(join(f.root, 'asset.bin'), 'held edit'); const checkpoint = await f.capture(1);
  const target = mkdtempSync(join(tmpdir(), 'gitspace-lfs-target-')); roots.push(target); git(target, 'init', '-b', 'untouched');
  git(target, 'fetch', f.root, `${checkpoint.checkpointRef}:${checkpoint.checkpointRef}`);
  await expect(restoreGitIntermediateCheckpoint({ repositoryPath: target, checkpoint, branch: 'main', lfs: { ...f.lfs, store: { has: async () => false, get: async () => null } } })).rejects.toThrow('Missing Git LFS object');
  expect(git(target, 'symbolic-ref', 'HEAD')).toBe('refs/heads/untouched'); expect(existsSync(join(target, 'asset.bin'))).toBe(false);
  await restoreGitIntermediateCheckpoint({ repositoryPath: target, checkpoint, branch: 'main', lfs: f.lfs });
  expect(readFileSync(join(target, '.git/lfs/objects', f.base.object.oid.slice(0, 2), f.base.object.oid.slice(2, 4), f.base.object.oid))).toEqual(Buffer.from(f.base.bytes));
  expect(await restoredGitLfsPaths(target, checkpoint.worktreeCommit, checkpoint.lfs)).toEqual([{ path: 'asset.bin', outcome: 'committed' }]);
  expect(readFileSync(join(target, 'asset.bin'), 'utf8')).toBe('committed bytes');
  expect(JSON.parse(readFileSync(join(target, '.git/gitspace-lfs-restored.json'), 'utf8'))).toEqual([{ path: 'asset.bin', outcome: 'committed' }]);
});

it('reports removed held-back paths from the restored worktree, not HEAD', async () => {
  const f = fixture();
  writeFileSync(join(f.root, 'asset.bin'), 'private staged edit'); git(f.root, 'add', 'asset.bin');
  rmSync(join(f.root, 'asset.bin'));
  const checkpoint = await f.capture(1);
  const target = mkdtempSync(join(tmpdir(), 'gitspace-lfs-removed-')); roots.push(target);
  git(target, 'init', '-b', 'main'); git(target, 'fetch', f.root, `${checkpoint.checkpointRef}:${checkpoint.checkpointRef}`);
  await restoreGitIntermediateCheckpoint({ repositoryPath: target, checkpoint, branch: 'main', lfs: f.lfs });
  expect(existsSync(join(target, 'asset.bin'))).toBe(false);
  expect(JSON.parse(readFileSync(join(target, '.git/gitspace-lfs-restored.json'), 'utf8'))).toEqual([{ path: 'asset.bin', outcome: 'omitted' }]);
});

it('does not interpret working attributes as authority for an ordinary file', async () => {
  const f = fixture(); writeFileSync(join(f.root, 'ordinary.txt'), 'base'); git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'ordinary');
  writeFileSync(join(f.root, '.gitattributes'), '* filter=lfs\n'); writeFileSync(join(f.root, 'ordinary.txt'), 'ordinary edit');
  const checkpoint = await f.capture(1); expect(git(f.root, 'show', `${checkpoint.worktreeCommit}:ordinary.txt`)).toBe('ordinary edit'); expect(checkpoint.lfs?.heldBack).toEqual([]);
});

it('publishes only private Git refs without invoking snapshot LFS or pre-push origin uploads', async () => {
  const f = fixture(); const checkpoint = await f.capture(1);
  const remote = join(f.root, 'artifacts.git'); git(f.root, 'init', '--bare', remote);
  git(f.root, 'config', `url.${remote}.insteadOf`, 'https://artifacts.invalid/repository');
  const marker = join(f.root, 'hook-ran');
  const hook = join(f.root, '.git/hooks/pre-push');
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`); chmodSync(hook, 0o755);
  const publication = new ArtifactsGitRemote({ credentials: async () => ({ remote: 'https://artifacts.invalid/repository', plaintext: 'offline-token', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }) });
  await publication.publishCheckpoint({ repositoryPath: f.root, binding: { projectId: 'project', repository: 'workspace-space' }, checkpointRef: checkpoint.checkpointRef });
  expect(git(remote, 'rev-parse', checkpoint.checkpointRef)).toBe(checkpoint.worktreeCommit);
  expect(existsSync(marker)).toBe(false);
  // Normal deliberate pushes still execute the unchanged project hook.
  expect(() => git(f.root, 'push', remote, 'main')).toThrow();
  expect(existsSync(marker)).toBe(true);
});

it('recovers ordinary staged bytes cleaned by working-only attributes without uploading them', async () => {
  const f = fixture();
  writeFileSync(join(f.root, 'ordinary.txt'), 'ordinary base'); git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'ordinary base');
  const staged = f.pointer('ordinary staged payload');
  writeFileSync(join(f.root, '.gitattributes'), '* filter=lfs\n');
  writeFileSync(join(f.root, 'ordinary.txt'), staged.text); git(f.root, 'add', 'ordinary.txt');
  writeFileSync(join(f.root, 'ordinary.txt'), 'ordinary current payload');
  const originalIndex = git(f.root, 'write-tree');
  const checkpoint = await f.capture(1);
  expect(git(f.root, 'show', `${checkpoint.indexCommit}:ordinary.txt`)).toBe('ordinary staged payload');
  expect(git(f.root, 'show', `${checkpoint.worktreeCommit}:ordinary.txt`)).toBe('ordinary current payload');
  expect(f.uploads).toEqual([f.base.object.oid]);
  expect(git(f.root, 'write-tree')).toBe(originalIndex);
});

it('does not report an unchanged hydrated file and reports staged additions as omitted on restore', async () => {
  const f = fixture(); writeFileSync(join(f.root, 'asset.bin'), f.base.bytes);
  const clean = await f.capture(1); expect(clean.lfs?.heldBack).toEqual([]);
  const added = f.pointer('new staged bytes'); writeFileSync(join(f.root, 'added.bin'), added.text); git(f.root, 'add', 'added.bin');
  const checkpoint = await f.capture(2);
  expect(await restoredGitLfsPaths(f.root, checkpoint.worktreeCommit, checkpoint.lfs)).toEqual([{ path: 'added.bin', outcome: 'omitted' }]);
  expect(f.uploads).toEqual([f.base.object.oid]);
});

it('uses saved lfsconfig for offline origin fallback rather than target working configuration', async () => {
  const f = fixture(); writeFileSync(join(f.root, '.lfsconfig'), '[lfs]\nurl = https://lfs.origin.invalid/objects\n'); git(f.root, 'add', '.lfsconfig'); git(f.root, 'commit', '-m', 'routing');
  git(f.root, 'config', 'remote.origin.url', 'https://origin.invalid/repo.git');
  const confirmation = spyOn(globalThis, 'fetch').mockImplementation(fetchImplementation(async () => Response.json({ objects: [{ ...f.base.object, actions: { download: { href: 'https://lfs.origin.invalid/payload' } } }] })));
  const checkpoint = await f.capture(1);
  expect(checkpoint.lfs?.objects).toEqual([{ ...f.base.object, source: 'origin', location: { origin: 'https://origin.invalid/repo.git', endpoint: 'https://lfs.origin.invalid/objects' } }]);
  expect(f.uploads).toEqual([]);
  const target = mkdtempSync(join(tmpdir(), 'gitspace-lfs-origin-')); roots.push(target); git(target, 'init', '-b', 'main'); git(target, 'fetch', f.root, `${checkpoint.checkpointRef}:${checkpoint.checkpointRef}`);
  writeFileSync(join(target, '.lfsconfig'), 'wrong working route\n');
  const bin = join(target, 'tools'); mkdirSync(bin); const executable = join(bin, 'git-lfs');
  writeFileSync(executable, '#!/bin/sh\n[ \"$1\" = smudge ] || exit 10\n[ \"$(cat \"$GIT_WORK_TREE/.lfsconfig\")\" = \"[lfs]\nurl = https://lfs.origin.invalid/objects\" ] || exit 11\ncat >/dev/null\nprintf \"committed bytes\"\n'); chmodSync(executable, 0o755);
  const lfs = { store: { has: async () => false, get: async () => null }, originEnvironment: async () => ({ PATH: `${bin}:${process.env.PATH ?? ''}` }) };
  await restoreGitIntermediateCheckpoint({ repositoryPath: target, checkpoint, branch: 'main', lfs });
  expect(readFileSync(join(target, 'asset.bin'), 'utf8')).toBe('committed bytes');
  expect(readFileSync(join(target, '.lfsconfig'), 'utf8')).toBe('[lfs]\nurl = https://lfs.origin.invalid/objects\n');
  confirmation.mockRestore();
});

it('never treats stale or old-origin remote refs as server availability', async () => {
  const f = fixture(); git(f.root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(f.root, 'config', 'remote.origin.url', 'https://old.invalid/repo.git');
  const request = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }));
  try {
    const checkpoint = await f.capture(1);
    expect(checkpoint.lfs?.objects).toEqual([{ ...f.base.object, source: 'r2' }]);
    expect(f.uploads).toEqual([f.base.object.oid]);
    git(f.root, 'config', 'remote.origin.url', 'https://new.invalid/repo.git');
    f.objects.clear();
    await f.capture(2);
    expect(f.uploads).toEqual([f.base.object.oid, f.base.object.oid]);
  } finally { request.mockRestore(); }
});

it('confirms exact objects with scoped credentials, remembers negatives and invalidates changed origin', async () => {
  const f = fixture();
  git(f.root, 'config', 'remote.origin.url', 'https://git.invalid/repo.git');
  writeFileSync(join(f.root, '.lfsconfig'), '[lfs]\nurl = https://lfs.invalid/project\n');
  git(f.root, 'add', '.lfsconfig'); git(f.root, 'commit', '-m', 'committed routing');
  writeFileSync(join(f.root, '.lfsconfig'), '[lfs]\nurl = https://untrusted.invalid/wrong\n');
  f.lfs.originEnvironment = async () => ({
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://lfs.invalid.helper',
    GIT_CONFIG_VALUE_1: '!f() { printf \"username=project\\npassword=secret\\n\"; }; f',
  });
  let present = false;
  const calls: string[] = [];
  const request = spyOn(globalThis, 'fetch').mockImplementation(fetchImplementation(async (input, init) => {
    calls.push(String(input));
    expect(String(input)).toBe('https://lfs.invalid/project/objects/batch');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Basic ${Buffer.from('project:secret').toString('base64')}`);
    expect(init?.redirect).toBe('error');
    expect(JSON.parse(String(init?.body))).toEqual({ operation: 'download', transfers: ['basic'], objects: [f.base.object] });
    return Response.json({ objects: [{ ...f.base.object, ...(present ? { actions: { download: { href: 'https://cdn.invalid/object' } } } : { error: { code: 404 } }) }] });
  }));
  try {
    expect((await f.capture(1)).lfs?.objects[0]?.source).toBe('r2');
    present = true;
    expect((await f.capture(2)).lfs?.objects[0]?.source).toBe('r2');
    await f.capture(3); expect(calls).toHaveLength(1);
    git(f.root, 'config', 'remote.origin.url', 'https://other.invalid/repo.git');
    present = false;
    expect((await f.capture(4)).lfs?.objects[0]?.source).toBe('r2');
    expect(calls).toHaveLength(2);
  } finally { request.mockRestore(); }
});

it('does not confirm mismatched sizes, missing actions, errors or redirects', async () => {
  const f = fixture();
  for (const object of [
    { ...f.base.object, size: f.base.object.size + 1, actions: { download: { href: 'https://cdn.invalid/a' } } },
    f.base.object,
    { ...f.base.object, error: { code: 404 }, actions: { download: { href: 'https://cdn.invalid/a' } } },
  ]) {
    expect(await confirmGitLfsObjects({ endpoint: 'https://origin.invalid/lfs', objects: [f.base.object], fetcher: async () => Response.json({ objects: [object] }) })).toEqual([]);
  }
  expect(await confirmGitLfsObjects({ endpoint: 'https://origin.invalid/lfs', objects: [f.base.object], fetcher: async (_input, init) => {
    expect(init?.redirect).toBe('error');
    return new Response(null, { status: 307, headers: { location: 'https://untrusted.invalid' } });
  } })).toEqual([]);
});

it('reuses durable inventory at unchanged HEAD and scans only added history until a rewrite', async () => {
  const f = fixture();
  for (let i = 0; i < 40; i++) git(f.root, 'commit', '--allow-empty', '-m', `ordinary ${i}`);
  const head = git(f.root, 'rev-parse', 'HEAD');
  const walks: string[][] = []; const commands: string[][] = [];
  const run = async (root: string, args: string[]) => { commands.push(args); return new TextEncoder().encode(git(root, ...args)); };
  const scan = async (_root: string, revisions: string[]) => { walks.push(revisions); return new Map([[f.base.object.oid, f.base.object]]); };
  await committedLfsInventory(f.root, head, run, scan);
  commands.length = 0;
  expect([...(await committedLfsInventory(f.root, head, run, scan)).values()]).toEqual([f.base.object]);
  expect(walks).toEqual([[head]]);
  expect(commands).toEqual([['rev-parse', '--git-path', 'gitspace-lfs-inventory.json']]);
  git(f.root, 'commit', '--allow-empty', '-m', 'new');
  const next = git(f.root, 'rev-parse', 'HEAD');
  await committedLfsInventory(f.root, next, run, scan);
  expect(walks).toEqual([[head], [next, `^${head}`]]);
  git(f.root, 'checkout', '--orphan', 'rewritten'); git(f.root, 'rm', '-rf', '.');
  const replacement = f.pointer('replacement history'); writeFileSync(join(f.root, 'replacement.bin'), replacement.text);
  git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'rewrite');
  const rewritten = git(f.root, 'rev-parse', 'HEAD');
  const inventory = await committedLfsInventory(f.root, rewritten, run, async (_root, revisions) => {
    expect(revisions).toEqual([rewritten]); return new Map([[replacement.object.oid, replacement.object]]);
  });
  expect([...inventory.values()]).toEqual([replacement.object]);
  const captured = await f.capture(1);
  expect(captured.lfs?.objects).toEqual([{ ...replacement.object, source: 'r2' }]);
});

it('uses rewritten project SSH authentication and acknowledges fresh canonical-origin receipts before caching', async () => {
  const f = fixture();
  git(f.root, 'config', 'remote.origin.url', 'https://git.invalid/team/repo.git');
  const ssh = join(f.root, '.git', 'test-ssh');
  const args = join(f.root, '.git', 'ssh-args');
  writeFileSync(ssh, `#!/bin/sh\nprintf '%s\\n' \"$@\" > '${args}'\nprintf '%s' '{\"href\":\"https://lfs.invalid/team/repo\",\"header\":{\"Authorization\":\"Bearer ssh-token\"}}'\n`);
  chmodSync(ssh, 0o755);
  let acknowledgements = 0;
  const lfs = {
    ...f.lfs, canonicalOrigin: 'https://git.invalid/team/repo.git',
    originEnvironment: async () => ({
      GIT_SSH_COMMAND: ssh, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'url.git@git.invalid:.insteadOf', GIT_CONFIG_VALUE_0: 'https://git.invalid/',
    }),
    confirmOrigin: async (receipt: GitLfsOriginConfirmation) => {
      expect(receipt).toEqual({ origin: 'https://git.invalid/team/repo.git', endpoint: 'https://lfs.invalid/team/repo', objects: [f.base.object] });
      if (++acknowledgements === 1) throw new Error('receipt acknowledgement lost');
    },
  };
  let requests = 0;
  const request = spyOn(globalThis, 'fetch').mockImplementation(fetchImplementation(async (input, init) => {
    requests++;
    expect(String(input)).toBe('https://lfs.invalid/team/repo/objects/batch');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ssh-token');
    return Response.json({ objects: [{ ...f.base.object, actions: { download: { href: 'https://cdn.invalid/payload' } } }] });
  }));
  try {
    const capture = (revision: number) => createGitIntermediateCheckpoint({ repositoryPath: f.root, spaceId: 'space', revision, lfs });
    await expect(capture(1)).rejects.toThrow('receipt acknowledgement lost');
    expect((await capture(2)).lfs?.objects[0]?.source).toBe('origin');
    await capture(3);
    expect(requests).toBe(2); expect(acknowledgements).toBe(2);
    expect(readFileSync(args, 'utf8')).toContain("git-lfs-authenticate 'team/repo.git' download");
    git(f.root, 'config', 'remote.origin.url', 'https://git.invalid/other/fork.git');
    expect((await capture(4)).lfs?.objects[0]?.source).toBe('r2');
    expect(requests).toBe(2);
    expect((await createGitIntermediateCheckpoint({ repositoryPath: f.root, spaceId: 'space', revision: 5, lfs: { ...lfs, canonicalOrigin: null } })).lfs?.objects[0]?.source).toBe('r2');
  } finally { request.mockRestore(); }
});

it('drops discarded rewritten-history pointers but retains reachable deleted-file pointers', async () => {
  const f = fixture();
  await f.capture(1);
  git(f.root, 'rm', 'asset.bin'); git(f.root, 'commit', '-m', 'deleted reachable payload');
  expect((await f.capture(2)).lfs?.objects).toEqual([{ ...f.base.object, source: 'r2' }]);
  git(f.root, 'checkout', '--orphan', 'replacement-history'); git(f.root, 'rm', '-rf', '.');
  const replacement = f.pointer('new root payload');
  writeFileSync(join(f.root, 'replacement.bin'), replacement.text); git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'new root');
  expect((await f.capture(3)).lfs?.objects).toEqual([{ ...replacement.object, source: 'r2' }]);
  expect((await f.capture(4)).lfs?.objects).toEqual([{ ...replacement.object, source: 'r2' }]);
});

it('hydrates a transitioned portable object from its confirmed endpoint after route changes', async () => {
  const f = fixture();
  writeFileSync(join(f.root, '.lfsconfig'), '[lfs]\nurl = https://new.invalid/lfs?token=new-secret\n');
  git(f.root, 'add', '.lfsconfig'); git(f.root, 'commit', '-m', 'changed endpoint');
  const checkpoint = await f.capture(1);
  const target = mkdtempSync(join(tmpdir(), 'gitspace-lfs-provenance-')); roots.push(target);
  git(target, 'init', '-b', 'main'); git(target, 'fetch', f.root, `${checkpoint.checkpointRef}:${checkpoint.checkpointRef}`);
  git(target, 'config', 'lfs.url', 'https://new.invalid/lfs?token=local-secret');
  const bin = join(target, 'tools'); mkdirSync(bin);
  const executable = join(bin, 'git-lfs');
  writeFileSync(executable, '#!/bin/sh\n[ "$1" = smudge ] || exit 10\n[ "$(git config lfs.url)" = "https://confirmed.invalid/lfs" ] || exit 11\ncat >/dev/null\nprintf "committed bytes"\n');
  chmodSync(executable, 0o755);
  await restoreGitIntermediateCheckpoint({ repositoryPath: target, checkpoint, branch: 'main', lfs: {
    store: { has: async () => false, get: async () => null },
    originEnvironment: async () => ({ PATH: `${bin}:${process.env.PATH ?? ''}` }),
    resolveSources: async objects => objects.map(object => ({ ...object, source: 'origin', location: { origin: 'https://origin.invalid/repo.git', endpoint: 'https://confirmed.invalid/lfs' } })),
  } });
  expect(readFileSync(join(target, 'asset.bin'), 'utf8')).toBe('committed bytes');
  expect(readFileSync(join(target, '.lfsconfig'), 'utf8')).toBe('[lfs]\nurl = https://new.invalid/lfs?token=new-secret\n');
});

it('unchanged capture launches no committed-history scan after durable inventory recovery', async () => {
  const f = fixture();
  for (let i = 0; i < 40; i++) git(f.root, 'commit', '--allow-empty', '-m', `history ${i}`);
  await f.capture(1);
  const processes = spyOn(Bun, 'spawn');
  try {
    await f.capture(2);
    const historyWalks = processes.mock.calls.filter(([command]) => Array.isArray(command) && command.includes('rev-list') && command.includes('--objects'));
    expect(historyWalks).toHaveLength(0);
    expect(f.uploads).toEqual([f.base.object.oid]);
  } finally { processes.mockRestore(); }
});

it('persists negative discovery across origin helpers and checks only newly discovered oids', async () => {
  const f = fixture();
  git(f.root, 'config', 'lfs.url', 'https://lfs.invalid/repo');
  git(f.root, 'config', 'remote.origin.url', 'https://origin.invalid/repo.git');
  const next = f.pointer('new discovery');
  const batches: unknown[] = [];
  const request = spyOn(globalThis, 'fetch').mockImplementation(fetchImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    batches.push(body.objects);
    return Response.json({ objects: body.objects.map((object: typeof f.base.object) => ({ ...object, error: { code: 404 } })) });
  }));
  try {
    await f.capture(1);
    await f.capture(2);
    expect(batches).toEqual([[f.base.object]]);
    // A new helper reads disk each time: no process-local cache supplies these classifications.
    writeFileSync(join(f.root, 'next.bin'), next.text); git(f.root, 'add', 'next.bin'); git(f.root, 'commit', '-m', 'new oid');
    await f.capture(3); await f.capture(4);
    expect(batches).toEqual([[f.base.object], [next.object]]);
  } finally { request.mockRestore(); }
});

it('does not repeat a failed origin batch for unchanged HEAD', async () => {
  const f = fixture();
  git(f.root, 'config', 'lfs.url', 'https://lfs.invalid/repo');
  const request = spyOn(globalThis, 'fetch').mockImplementation(fetchImplementation(async () => new Response(null, { status: 404 })));
  try {
    await f.capture(1); await f.capture(2); await f.capture(3);
    expect(request).toHaveBeenCalledTimes(1);
    expect(f.uploads).toEqual([f.base.object.oid]);
  } finally { request.mockRestore(); }
});

for (const configuration of ['local', 'committed']) it(`keeps ${configuration} query credentials out of receipts while native hydration retains them`, async () => {
  const f = fixture();
  const configured = 'https://machine:password@lfs.invalid/repo?token=machine-secret#private';
  git(f.root, 'config', 'remote.origin.url', 'https://user:origin-secret@origin.invalid/repo.git?token=origin-query#private');
  if (configuration === 'local') git(f.root, 'config', 'lfs.url', configured);
  else {
    writeFileSync(join(f.root, '.lfsconfig'), `[lfs]\nurl = "${configured}"\n`);
    git(f.root, 'add', '.lfsconfig'); git(f.root, 'commit', '-m', 'committed credentials');
  }
  const receipts: GitLfsOriginConfirmation[] = [];
  const request = spyOn(globalThis, 'fetch').mockImplementation(fetchImplementation(async (input, init) => {
    if (String(input) === 'https://cdn.invalid/object') {
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      return new Response(f.base.bytes);
    }
    expect(new Headers(init?.headers).get('authorization')).toBe(`Basic ${Buffer.from('machine:password').toString('base64')}`);
    expect(new URL(String(input)).search).toBe('?token=machine-secret');
    return Response.json({ objects: [{ ...f.base.object, actions: { download: { href: 'https://cdn.invalid/object' } } }] });
  }));
  try {
    const checkpoint = await createGitIntermediateCheckpoint({ repositoryPath: f.root, spaceId: 'space', revision: 1, lfs: { ...f.lfs, confirmOrigin: async receipt => { receipts.push(receipt); } } });
    const location = { origin: 'https://origin.invalid/repo.git', endpoint: 'https://lfs.invalid/repo' };
    expect(receipts).toEqual([{ ...location, objects: [f.base.object] }]);
    expect(checkpoint.lfs?.objects).toEqual([{ ...f.base.object, source: 'origin', location }]);
    expect(readFileSync(join(f.root, '.git/gitspace-lfs-origin-inventory.json'), 'utf8')).not.toContain('machine-secret');
    const target = mkdtempSync(join(tmpdir(), 'gitspace-lfs-secret-route-')); roots.push(target);
    git(target, 'init', '-b', 'main'); git(target, 'fetch', f.root, `${checkpoint.checkpointRef}:${checkpoint.checkpointRef}`);
    if (configuration === 'local') git(target, 'config', 'lfs.url', configured);
    await restoreGitIntermediateCheckpoint({ repositoryPath: target, checkpoint, branch: 'main', lfs: f.lfs });
    expect(readFileSync(join(target, 'asset.bin'), 'utf8')).toBe('committed bytes');
  } finally { request.mockRestore(); }
});

it('rotates bounded authenticated retention rechecks without retrying negative captures', async () => {
  const f = fixture();
  git(f.root, 'config', 'remote.origin.url', 'https://origin.invalid/repo.git');
  git(f.root, 'config', 'lfs.url', 'https://lfs.invalid/repo?token=private');
  const objects = [f.base.object];
  for (let i = 0; i < 69; i++) {
    const next = f.pointer(`retained payload ${i}`);
    objects.push(next.object);
    writeFileSync(join(f.root, `${i}.bin`), next.text);
  }
  git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'retained inventory');
  let present = false;
  const batches: Array<Array<typeof f.base.object>> = [];
  const receipts: GitLfsOriginConfirmation[] = [];
  const access = { ...f.lfs, confirmOrigin: async (receipt: GitLfsOriginConfirmation) => { receipts.push(receipt); } };
  const capture = (revision: number) => createGitIntermediateCheckpoint({ repositoryPath: f.root, spaceId: 'space', revision, lfs: access });
  const request = spyOn(globalThis, 'fetch').mockImplementation(fetchImplementation(async (input, init) => {
    expect(new URL(String(input)).search).toBe('?token=private');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const requested = GitLfsObjectSchema.array().parse(JSON.parse(String(init?.body)).objects);
    batches.push(requested);
    return Response.json({ objects: requested.map(object => ({ ...object, ...(present ? { actions: { download: { href: 'https://cdn.invalid/payload' } } } : { error: { code: 404 } }) })) });
  }));
  try {
    await capture(1); await capture(2);
    expect(batches.map(batch => batch.length)).toEqual([70]);
    await recheckGitLfsOrigin(f.root, access);
    expect(batches.map(batch => batch.length)).toEqual([70, 64]);
    present = true;
    await recheckGitLfsOrigin(f.root, access);
    expect(batches[2]?.slice(0, 6)).toEqual([...objects].sort((a, b) => a.oid.localeCompare(b.oid)).slice(64));
    await recheckGitLfsOrigin(f.root, access);
    expect(batches.map(batch => batch.length)).toEqual([70, 64, 64, 6]);
    expect(receipts.flatMap(receipt => receipt.objects).map(object => object.oid).sort()).toEqual(objects.map(object => object.oid).sort());
    expect(receipts.every(receipt => receipt.endpoint === 'https://lfs.invalid/repo')).toBe(true);
    const confirmed = await capture(3);
    expect(confirmed.lfs?.objects.every(object => object.source === 'origin')).toBe(true);
    expect(batches).toHaveLength(4);
    await recheckGitLfsOrigin(f.root, access);
    expect(batches).toHaveLength(4);
  } finally { request.mockRestore(); }
});
