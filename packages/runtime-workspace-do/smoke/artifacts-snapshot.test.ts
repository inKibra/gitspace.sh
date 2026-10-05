import { test, expect, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import git from 'isomorphic-git';
import fs from 'node:fs';
import { writeArtifactsSnapshot, type ArtifactsFetch, type RuntimeGitCheckpoint } from '../src/artifacts-snapshot.js';
import { ArtifactsCodeStore } from '../src/artifacts.js';

const text = new TextEncoder();
const author = { name: 'Fixture', email: 'fixture@example.invalid', timestamp: 1, timezoneOffset: 0 };
async function fixture(defaultBranch = 'main') {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-snapshot-'));
  await git.init({ fs, dir, defaultBranch });
  const write = async (value: Uint8Array) => git.writeBlob({ fs, dir, blob: value });
  const lfs = text.encode(`version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 999\n`);
  const nested = await git.writeTree({ fs, dir, tree: [{ mode: '100644', path: 'untouched', oid: await write(text.encode('large remote subtree')), type: 'blob' }] });
  const tree = await git.writeTree({ fs, dir, tree: [
    { mode: '100755', path: 'script', oid: await write(text.encode('before')), type: 'blob' },
    { mode: '100644', path: 'asset', oid: await write(lfs), type: 'blob' },
    { mode: '120000', path: 'link', oid: await write(text.encode('script')), type: 'blob' },
    { mode: '040000', path: 'nested', oid: nested, type: 'tree' },
  ] });
  const commit = await git.writeCommit({ fs, dir, commit: { tree, parent: [], author, committer: author, message: 'base\n' } });
  await git.writeRef({ fs, dir, ref: `refs/heads/${defaultBranch}`, value: commit });
  const previous: RuntimeGitCheckpoint = { checkpointRef: 'refs/gitspace/spaces/workspace/checkpoints', headCommit: commit, branch: defaultBranch, indexCommit: commit, trackedWorktreeCommit: commit, worktreeCommit: commit, indexTree: tree, worktreeTree: tree };
  await git.writeRef({ fs, dir, ref: previous.checkpointRef, value: commit });
  const fetched: string[] = [];
  let minted = 0; let revoked = 0;
  const repo = {
    async readCommit(oid: string): Promise<ArtifactsCommitMetadata> {
      const value = (await git.readCommit({ fs, dir, oid })).commit;
      return { hash: oid, treeHash: value.tree, parents: value.parent, message: value.message, author: value.author, committer: value.committer, authoredAt: value.author.timestamp, committedAt: value.committer.timestamp };
    },
    async readTree(oid: string): Promise<ArtifactsTreeEntry[]> {
      fetched.push(oid);
      return (await git.readTree({ fs, dir, oid })).tree.map(entry => ({ name: entry.path, hash: entry.oid, mode: entry.mode, type: entry.type === 'tree' ? 'tree' : entry.type === 'commit' ? 'gitlink' : entry.mode === '120000' ? 'symlink' : entry.mode === '100755' ? 'exec' : 'blob' }));
    },
    async info(): Promise<ArtifactsRepoInfo> { return { id: 'fixture', name: 'fixture', description: null, defaultBranch, createdAt: '', updatedAt: '', lastPushAt: null, source: null, readOnly: false, remote: 'https://fixture.invalid/repo.git' }; },
    async createToken(): Promise<ArtifactsCreateTokenResult> { minted++; return { id: 'lease', plaintext: 'secret', scope: 'write', expiresAt: '' }; },
    async revokeToken() { revoked++; return true; },
    async log(options?: Parameters<ArtifactsRepo['log']>[0]): Promise<ArtifactsCommitMetadata[]> {
      const ref = options?.ref;
      const commitId = ref !== undefined && /^[0-9a-f]{40}$/u.test(ref);
      if (ref !== undefined && !commitId && (ref === 'HEAD' || ref.startsWith('refs/') || !(await git.listBranches({ fs, dir })).includes(ref))) return [];
      try {
        const oid = await git.resolveRef({ fs, dir, ref: ref === undefined ? 'HEAD' : commitId ? ref : `refs/heads/${ref}` });
        return [await repo.readCommit(oid)];
      } catch (error) {
        if (error instanceof git.Errors.NotFoundError) return [];
        throw error;
      }
    },
  };
  const request: ArtifactsFetch = async (input, init) => {
    const url = String(input);
    const advertise = url.includes('/info/refs');
    const child = Bun.spawn(['git', '-c', 'core.bare=true', 'receive-pack', '--stateless-rpc', ...(advertise ? ['--advertise-refs'] : []), dir], { stdin: advertise ? 'ignore' : new Response(init?.body).body, stdout: 'pipe', stderr: 'pipe' });
    const bytes = new Uint8Array(await new Response(child.stdout).arrayBuffer());
    const stderr = await new Response(child.stderr).text();
    if (await child.exited !== 0) throw new Error(stderr);
    return new Response(bytes);
  };
  return { dir, tree, nested, lfs, previous, fetched, repo, request, credentials: () => ({ minted, revoked }), close: () => rm(dir, { recursive: true, force: true }) };
}

test('bounded snapshot push preserves HEAD/index, executable/symlink/LFS bytes and binary data; retry is idempotent', async () => {
  const f = await fixture();
  try {
    const binary = new Uint8Array([0, 255, 128, 10]);
    const input = { repository: 'fixture', workspaceId: 'workspace', previous: f.previous, mutations: [{ path: 'script', content: binary }, { path: 'new/file', content: binary }] };
    const result = await writeArtifactsSnapshot(f.repo, input, f.request);
    if (result.isErr()) throw result.error;
    const checkpoint = result.value;
    expect(checkpoint.headCommit).toBe(f.previous.headCommit);
    expect(checkpoint.indexCommit).toBe(f.previous.indexCommit);
    expect(checkpoint.indexTree).toBe(f.previous.indexTree);
    expect(checkpoint.branch).toBe('main');
    expect((await git.readCommit({ fs, dir: f.dir, oid: checkpoint.worktreeCommit })).commit.parent[0]).toBe(f.previous.worktreeCommit);
    expect(await git.resolveRef({ fs, dir: f.dir, ref: checkpoint.checkpointRef })).toBe(checkpoint.worktreeCommit);
    expect(f.previous.headCommit).toBe(await git.resolveRef({ fs, dir: f.dir, ref: 'refs/heads/main' }));
    expect(f.fetched).not.toContain(f.nested);
    expect(new Set(f.fetched).size).toBe(1);
    const files = (await git.readTree({ fs, dir: f.dir, oid: checkpoint.worktreeTree })).tree;
    expect(files.find(entry => entry.path === 'script')?.mode).toBe('100755');
    expect(files.find(entry => entry.path === 'link')?.mode).toBe('120000');
    expect((await git.readBlob({ fs, dir: f.dir, oid: checkpoint.worktreeCommit, filepath: 'script' })).blob).toEqual(binary);
    expect((await git.readBlob({ fs, dir: f.dir, oid: checkpoint.worktreeCommit, filepath: 'asset' })).blob).toEqual(f.lfs);
    const again = await writeArtifactsSnapshot(f.repo, input, f.request);
    if (again.isErr()) throw again.error;
    expect(again.value).toEqual(checkpoint);
    expect(f.credentials()).toEqual({ minted: 2, revoked: 2 });
    const conflict = await writeArtifactsSnapshot(f.repo, { ...input, mutations: [{ path: 'script', content: text.encode('other writer') }] }, f.request);
    expect(conflict.isErr()).toBe(true);
    expect(f.credentials()).toEqual({ minted: 3, revoked: 3 });
    const deleted = await writeArtifactsSnapshot(f.repo, { ...input, previous: checkpoint, mutations: [{ path: 'script', content: null }, { path: 'new/file', content: null }] }, f.request);
    if (deleted.isErr()) throw deleted.error;
    const afterDelete = (await git.readTree({ fs, dir: f.dir, oid: deleted.value.worktreeTree })).tree;
    expect(afterDelete.some(entry => entry.path === 'script' || entry.path === 'new')).toBe(false);
  } finally { await f.close(); }
});

test('invalid paths and symlink traversal fail before credentials; transport failure revokes token', async () => {
  const f = await fixture();
  try {
    for (const path of ['../outside', '/absolute', 'a/../x', '.git/config', 'link/child']) {
      const result = await writeArtifactsSnapshot(f.repo, { repository: 'fixture', workspaceId: 'workspace', previous: f.previous, mutations: [{ path, content: text.encode('x') }] }, f.request);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error.certainty).toBe('not-published');
    }
    expect(f.credentials()).toEqual({ minted: 0, revoked: 0 });
    const failure = await writeArtifactsSnapshot(f.repo, { repository: 'fixture', workspaceId: 'workspace', previous: f.previous, mutations: [{ path: 'script', content: text.encode('changed') }] }, async () => new Response('unavailable', { status: 503 }));
    expect(failure.isErr()).toBe(true);
    if (failure.isErr()) expect(failure.error.certainty).toBe('not-published');
    expect(f.credentials()).toEqual({ minted: 1, revoked: 1 });
    const uncertain = await writeArtifactsSnapshot(f.repo, { repository: 'fixture', workspaceId: 'workspace', previous: f.previous, mutations: [{ path: 'script', content: text.encode('changed') }] }, async (input, init) => {
      if (init?.method === 'POST') throw new Error('Connection lost after sending request');
      return f.request(input, init);
    });
    expect(uncertain.isErr()).toBe(true);
    if (uncertain.isErr()) expect(uncertain.error.certainty).toBe('unknown');
    expect(f.credentials()).toEqual({ minted: 2, revoked: 2 });
  } finally { await f.close(); }
});

test('oversized mutation batches fail before any credential or ref effect', async () => {
  const f = await fixture();
  try {
    const mutations = Array.from({ length: 257 }, (_, index) => ({ path: `new-${index}`, content: new Uint8Array() }));
    const result = await writeArtifactsSnapshot(f.repo, { repository: 'fixture', workspaceId: 'workspace', previous: f.previous, mutations }, f.request);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.certainty).toBe('not-published');
    expect(await git.resolveRef({ fs, dir: f.dir, ref: f.previous.checkpointRef })).toBe(f.previous.worktreeCommit);
    expect(f.credentials()).toEqual({ minted: 0, revoked: 0 });
  } finally { await f.close(); }
});

for (const interrupted of [false, true]) test(`scratch initialization publishes a real initial commit on its default branch${interrupted ? ' after an interrupted push' : ''}`, async () => {
  const f = await fixture();
  let metadata: ArtifactsRepoInfo | null = null;
  let fail = interrupted;
  const request = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (fail) throw new Error('offline push interruption');
    return f.request(String(input), init);
  }, { preconnect: fetch.preconnect }));
  const unsupported = async (): Promise<never> => { throw new Error('Unexpected repository operation'); };
  const repo: ArtifactsRepo = {
    ...f.repo, [Symbol.dispose]() {}, listTokens: unsupported, readBlob: unsupported, readFile: unsupported, fork: unsupported,
    info: async () => { if (!metadata) throw new Error('Repository absent'); return metadata; },
  };
  const binding: Artifacts = {
    get: async () => repo, import: unsupported, delete: unsupported,
    list: async () => ({ repos: metadata ? [metadata] : [], total: metadata ? 1 : 0 }),
    create: async (name, options) => {
      if (metadata) throw new Error('Already exists');
      metadata = { ...await f.repo.info(), name, description: options?.description ?? null, defaultBranch: options?.setDefaultBranch ?? 'main' };
      return { id: metadata.id, name, description: metadata.description, remote: metadata.remote, token: 'initial', defaultBranch: metadata.defaultBranch };
    },
  };
  try {
    await rm(join(f.dir, '.git'), { recursive: true, force: true });
    await git.init({ fs, dir: f.dir, defaultBranch: 'main' });
    const code = new ArtifactsCodeStore(binding);
    if (interrupted) {
      await expect(code.ensureEmptyProject('scratch', 'main')).rejects.toThrow('offline push interruption');
      expect(await git.listBranches({ fs, dir: f.dir })).toEqual([]);
      fail = false;
    }
    await code.ensureEmptyProject('scratch', 'main');
    const head = await git.resolveRef({ fs, dir: f.dir, ref: 'refs/heads/main' });
    const commit = (await git.readCommit({ fs, dir: f.dir, oid: head })).commit;
    expect(commit.parent).toEqual([]);
    expect((await git.readTree({ fs, dir: f.dir, oid: commit.tree })).tree).toEqual([]);
    await code.ensureEmptyProject('scratch', 'main');
    expect(await git.resolveRef({ fs, dir: f.dir, ref: 'refs/heads/main' })).toBe(head);
    const advanced = await git.writeCommit({ fs, dir: f.dir, commit: { tree: commit.tree, parent: [head], author, committer: author, message: 'user history\n' } });
    await git.writeRef({ fs, dir: f.dir, ref: 'refs/heads/main', value: advanced, force: true });
    await code.ensureEmptyProject('scratch', 'main');
    expect(await git.resolveRef({ fs, dir: f.dir, ref: 'refs/heads/main' })).toBe(advanced);
    await git.deleteRef({ fs, dir: f.dir, ref: 'refs/heads/main' });
    metadata = { ...await repo.info(), description: null };
    await code.ensureEmptyProject('scratch', 'main');
    expect(await git.listBranches({ fs, dir: f.dir })).toEqual([]);
  } finally { request.mockRestore(); await f.close(); }
});

test('unborn cloud checkpoints publish complete root graphs without creating a branch and preserve no-op ancestry', async () => {
  const f = await fixture();
  try {
    await rm(join(f.dir, '.git'), { recursive: true, force: true });
    await git.init({ fs, dir: f.dir, defaultBranch: 'trunk' });
    const tree = await git.writeTree({ fs, dir: f.dir, tree: [] });
    const indexCommit = await git.writeCommit({ fs, dir: f.dir, commit: { tree, parent: [], author, committer: author, message: 'index\n' } });
    const trackedWorktreeCommit = await git.writeCommit({ fs, dir: f.dir, commit: { tree, parent: [indexCommit], author, committer: author, message: 'tracked\n' } });
    const worktreeCommit = await git.writeCommit({ fs, dir: f.dir, commit: { tree, parent: [trackedWorktreeCommit], author, committer: author, message: 'worktree\n' } });
    const initial = { tree, indexCommit, trackedWorktreeCommit, worktreeCommit };
    await git.writeRef({ fs, dir: f.dir, ref: 'refs/gitspace/spaces/workspace/checkpoints', value: worktreeCommit });
    const previous: RuntimeGitCheckpoint = { checkpointRef: 'refs/gitspace/spaces/workspace/checkpoints', headCommit: null, branch: 'trunk', indexCommit: initial.indexCommit, trackedWorktreeCommit: initial.trackedWorktreeCommit, worktreeCommit: initial.worktreeCommit, indexTree: initial.tree, worktreeTree: initial.tree };
    expect(await git.listBranches({ fs, dir: f.dir })).toEqual([]);
    expect((await git.readCommit({ fs, dir: f.dir, oid: initial.indexCommit })).commit.parent).toEqual([]);
    expect((await git.readCommit({ fs, dir: f.dir, oid: initial.trackedWorktreeCommit })).commit.parent).toContain(initial.indexCommit);
    const result = await writeArtifactsSnapshot(f.repo, { repository: 'fixture', workspaceId: 'workspace', previous, mutations: [{ path: 'cloud.txt', content: text.encode('before attachment') }] }, f.request);
    if (result.isErr()) throw result.error;
    const checkpoint = result.value;
    expect(checkpoint.headCommit).toBeNull();
    expect(checkpoint.branch).toBe('trunk');
    expect(checkpoint.indexTree).toBe(initial.tree);
    expect((await git.readTree({ fs, dir: f.dir, oid: (await git.readCommit({ fs, dir: f.dir, oid: checkpoint.trackedWorktreeCommit })).commit.tree })).tree).toEqual([]);
    expect(new TextDecoder().decode((await git.readBlob({ fs, dir: f.dir, oid: checkpoint.worktreeCommit, filepath: 'cloud.txt' })).blob)).toBe('before attachment');
    expect(await git.listBranches({ fs, dir: f.dir })).toEqual([]);
    const noop = await writeArtifactsSnapshot(f.repo, { repository: 'fixture', workspaceId: 'workspace', previous: checkpoint, mutations: [{ path: 'cloud.txt', content: text.encode('before attachment') }] }, f.request);
    if (noop.isErr()) throw noop.error;
    expect(noop.value).toEqual(checkpoint);
    const integrity = Bun.spawn(['git', '-C', f.dir, 'fsck', '--full'], { stdout: 'pipe', stderr: 'pipe' });
    const output = await new Response(integrity.stderr).text();
    expect(await integrity.exited, output).toBe(0);
  } finally { await f.close(); }
});

for (const empty of [false, true]) test(`initial checkpoint distinguishes ${empty ? 'genuinely empty imported repository' : 'missing workspace branch from committed source'}`, async () => {
  const f = await fixture();
  const request = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => f.request(String(input), init), { preconnect: fetch.preconnect }));
  const unsupported = async (): Promise<never> => { throw new Error('Unexpected repository operation'); };
  const repo: ArtifactsRepo = {
    ...f.repo, [Symbol.dispose]() {}, listTokens: unsupported, readBlob: unsupported, readFile: unsupported, fork: unsupported,
  };
  const code = new ArtifactsCodeStore({ get: async () => repo, create: unsupported, import: unsupported, delete: unsupported, list: unsupported });
  try {
    if (empty) {
      await rm(join(f.dir, '.git'), { recursive: true, force: true });
      await git.init({ fs, dir: f.dir, defaultBranch: 'main' });
    }
    const checkpoint = await code.initialCheckpoint('fixture', 'new-workspace', 'feature');
    if (!empty) {
      expect(checkpoint).toBeNull();
      expect(f.previous.headCommit).toBe(await git.resolveRef({ fs, dir: f.dir, ref: 'refs/heads/main' }));
      expect(f.credentials()).toEqual({ minted: 0, revoked: 0 });
    } else {
      expect(checkpoint).not.toBeNull();
      if (!checkpoint) throw new Error('Empty imported repository requires an unborn checkpoint');
      expect(checkpoint.headCommit).toBeNull();
      expect(checkpoint.branch).toBe('feature');
      expect(await git.resolveRef({ fs, dir: f.dir, ref: checkpoint.checkpointRef })).toBe(checkpoint.worktreeCommit);
      expect((await git.readCommit({ fs, dir: f.dir, oid: checkpoint.indexCommit })).commit.parent).toEqual([]);
      expect((await git.readTree({ fs, dir: f.dir, oid: checkpoint.indexTree })).tree).toEqual([]);
      const written = await code.writeSnapshot({ repository: 'fixture', workspaceId: 'new-workspace', previous: checkpoint, mutations: [{ path: 'cloud.txt', content: text.encode('before machine') }] });
      if (written.isErr()) throw written.error;
      expect(written.value.headCommit).toBeNull();
      expect(new TextDecoder().decode((await git.readBlob({ fs, dir: f.dir, oid: written.value.worktreeCommit, filepath: 'cloud.txt' })).blob)).toBe('before machine');
      expect(await git.listBranches({ fs, dir: f.dir })).toEqual([]);
    }
  } finally { request.mockRestore(); await f.close(); }
});

test('committed sources resolve observed branch and HEAD forms without treating populated history as unborn', async () => {
  const f = await fixture();
  const unsupported = async (): Promise<never> => { throw new Error('Unexpected repository operation'); };
  const repo: ArtifactsRepo = {
    ...f.repo, [Symbol.dispose]() {}, listTokens: unsupported, readBlob: unsupported, readFile: unsupported, fork: unsupported,
  };
  const code = new ArtifactsCodeStore({ get: async () => repo, create: unsupported, import: unsupported, delete: unsupported, list: unsupported });
  try {
    await git.writeRef({ fs, dir: f.dir, ref: 'refs/heads/feature/nested', value: f.previous.worktreeCommit });
    expect(await code.resolveRef('fixture', 'refs/heads/main')).toBe(f.previous.headCommit);
    expect(await code.resolveRef('fixture', 'feature/nested')).toBe(f.previous.headCommit);
    expect(await code.resolveRef('fixture', 'HEAD')).toBe(f.previous.headCommit);
    expect(await code.resolveRef('fixture', f.previous.worktreeCommit)).toBe(f.previous.worktreeCommit);
    expect(await code.resolveRef('fixture', 'refs/heads/missing')).toBeNull();
    expect((await code.log('fixture', f.previous.worktreeCommit))[0]?.hash).toBe(f.previous.worktreeCommit);
    const checkpoint = await code.initialCheckpoint('fixture', 'workspace', 'main');
    expect(checkpoint?.headCommit).toBe(f.previous.headCommit);
    expect(checkpoint?.worktreeTree).toBe(f.previous.worktreeTree);
    for (const ref of [f.previous.checkpointRef, 'refs/tags/v1', 'refs/remotes/origin/main', 'HEAD~1', 'main..other', 'refs/heads/', 'main.lock']) {
      await expect(code.resolveRef('fixture', ref)).rejects.toThrow();
    }
  } finally { await f.close(); }
});

test('repository operations support proxy handles without disposal and release workerd handles on failure', async () => {
  const f = await fixture();
  const unsupported = async (): Promise<never> => { throw new Error('Unexpected repository operation'); };
  let disposed = 0;
  const repo: ArtifactsRepo = {
    ...f.repo, [Symbol.dispose]() { disposed++; }, listTokens: unsupported, readBlob: unsupported, readFile: unsupported, fork: unsupported, log: unsupported,
  };
  const code = new ArtifactsCodeStore({ get: async () => repo, create: unsupported, import: unsupported, delete: unsupported, list: unsupported });
  try {
    await expect(code.readFile('fixture', f.previous.worktreeCommit, 'script')).rejects.toThrow('Unexpected repository operation');
    expect(disposed).toBe(1);
    Reflect.deleteProperty(repo, Symbol.dispose);
    expect((await code.readCommit('fixture', f.previous.worktreeCommit))?.treeHash).toBe(f.previous.worktreeTree);
  } finally { await f.close(); }
});

test('scratch recovery never seeds a missing branch when actual default HEAD has history', async () => {
  const f = await fixture('trunk');
  const metadata = { ...await f.repo.info(), name: 'project-scratch', description: 'GitSpace scratch project scratch (main)' };
  const unsupported = async (): Promise<never> => { throw new Error('Unexpected repository operation'); };
  const request = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => f.request(String(input), init), { preconnect: fetch.preconnect }));
  const repo: ArtifactsRepo = { ...f.repo, [Symbol.dispose]() {}, info: async () => metadata, listTokens: unsupported, readBlob: unsupported, readFile: unsupported, fork: unsupported };
  const code = new ArtifactsCodeStore({ get: async () => repo, list: async () => ({ repos: [metadata], total: 1 }), create: unsupported, import: unsupported, delete: unsupported });
  try {
    await code.ensureEmptyProject('scratch', 'main');
    expect(await git.listBranches({ fs, dir: f.dir })).toEqual(['trunk']);
    expect(await git.resolveRef({ fs, dir: f.dir, ref: 'HEAD' })).toBe(f.previous.worktreeCommit);
    expect(f.credentials()).toEqual({ minted: 0, revoked: 0 });
  } finally { request.mockRestore(); await f.close(); }
});

test('binding fake resolves omitted refs through actual HEAD without accepting full ref syntax', async () => {
  const f = await fixture('trunk');
  const unsupported = async (): Promise<never> => { throw new Error('Unexpected repository operation'); };
  const repo: ArtifactsRepo = { ...f.repo, [Symbol.dispose]() {}, listTokens: unsupported, readBlob: unsupported, readFile: unsupported, fork: unsupported };
  const code = new ArtifactsCodeStore({ get: async () => repo, list: unsupported, create: unsupported, import: unsupported, delete: unsupported });
  try {
    expect(await git.listBranches({ fs, dir: f.dir })).toEqual(['trunk']);
    expect((await repo.log({ limit: 1 }))[0]?.hash).toBe(f.previous.worktreeCommit);
    expect((await repo.log({ ref: 'trunk' }))[0]?.hash).toBe(f.previous.worktreeCommit);
    expect((await repo.log({ ref: f.previous.worktreeCommit }))[0]?.hash).toBe(f.previous.worktreeCommit);
    for (const ref of ['HEAD', 'main', 'refs/heads/trunk', 'heads/trunk', f.previous.checkpointRef]) expect(await repo.log({ ref })).toEqual([]);
    expect(await code.resolveRef('fixture', 'HEAD')).toBe(f.previous.headCommit);
    expect(await code.initialCheckpoint('fixture', 'missing-workspace', 'missing')).toBeNull();
  } finally { await f.close(); }
});
