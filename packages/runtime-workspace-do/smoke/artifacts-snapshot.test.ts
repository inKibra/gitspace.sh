import { test, expect, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import git from 'isomorphic-git';
import fs from 'node:fs';
import { writeArtifactsSnapshot, type ArtifactsFetch, type RuntimeGitCheckpoint } from '../src/artifacts-snapshot.js';
import { ArtifactsCodeStore } from '../src/artifacts.js';
import { planSnapshotMerge } from '../src/artifacts-merge.js';
import { RuntimeAttachmentSchema, RuntimeToolDispatchSchema } from '@gitspace/protocol-runtime';
import { ExecutorJournal } from '../../runtime-machine/src/journal.js';
import { MachineExecutor } from '../../runtime-machine/src/executor.js';

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
    async readBlob(oid: string): Promise<Blob> {
      return new Blob([Uint8Array.from((await git.readBlob({ fs, dir, oid })).blob)]);
    },
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

test('machine deltas merge onto cloud files and index with clean text merges, explicit conflicts and deterministic retry', async () => {
  const f = await fixture();
  try {
    const reader = { ...f.repo, readBlob: async (oid: string) => new Blob([Uint8Array.from((await git.readBlob({ fs, dir: f.dir, oid })).blob)]) };
    const snapshot = async (files: Record<string, string>, staged: Record<string, string> = files): Promise<RuntimeGitCheckpoint> => {
      const tree = async (entries: Record<string, string>) => git.writeTree({ fs, dir: f.dir, tree: await Promise.all(Object.entries(entries).map(async ([path, value]) => ({ path, mode: '100644', type: 'blob' as const, oid: await git.writeBlob({ fs, dir: f.dir, blob: text.encode(value) }) }))) });
      const worktreeTree = await tree(files), indexTree = await tree(staged);
      const commit = async (tree: string, message: string) => git.writeCommit({ fs, dir: f.dir, commit: { tree, parent: [f.previous.worktreeCommit], author, committer: author, message } });
      const indexCommit = await commit(indexTree, 'index\n'), worktreeCommit = await commit(worktreeTree, 'worktree\n');
      return { ...f.previous, worktreeTree, indexTree, indexCommit, worktreeCommit, trackedWorktreeCommit: worktreeCommit };
    };
    const baseFiles = { shared: 'one\ntwo\nthree\n', cloud: 'old cloud\n', machine: 'old machine\n' };
    const base = await snapshot(baseFiles);
    const cloud = await snapshot({ ...baseFiles, shared: 'ONE\ntwo\nthree\n', cloud: 'cloud edit\n' }, { ...baseFiles, cloud: 'cloud staged\n' });
    const machine = await snapshot({ ...baseFiles, shared: 'one\ntwo\nTHREE\n', machine: 'machine edit\n' }, { ...baseFiles, machine: 'machine staged\n' });
    await git.writeRef({ fs, dir: f.dir, ref: cloud.checkpointRef, value: cloud.worktreeCommit, force: true });
    const plan = await planSnapshotMerge(reader, base, cloud, machine);
    const input = { repository: 'fixture', workspaceId: 'workspace', previous: cloud, ...plan };
    const merged = await writeArtifactsSnapshot(f.repo, input, f.request);
    if (merged.isErr()) throw merged.error;
    const read = async (commit: string, path: string) => new TextDecoder().decode((await git.readBlob({ fs, dir: f.dir, oid: commit, filepath: path })).blob);
    expect(await read(merged.value.worktreeCommit, 'shared')).toBe('ONE\ntwo\nTHREE\n');
    expect(await read(merged.value.worktreeCommit, 'cloud')).toBe('cloud edit\n');
    expect(await read(merged.value.worktreeCommit, 'machine')).toBe('machine edit\n');
    expect(await read(merged.value.indexCommit, 'cloud')).toBe('cloud staged\n');
    expect(await read(merged.value.indexCommit, 'machine')).toBe('machine staged\n');
    expect(merged.value.headCommit).toBe(base.headCommit);
    expect(merged.value.conflicts).toEqual([]);
    const retry = await writeArtifactsSnapshot(f.repo, input, f.request);
    if (retry.isErr()) throw retry.error;
    expect(retry.value).toEqual(merged.value);
    const conflictMachine = await snapshot({ ...baseFiles, shared: 'DIFFERENT\ntwo\nthree\n' });
    const conflictPlan = await planSnapshotMerge(reader, base, merged.value, conflictMachine);
    const conflict = await writeArtifactsSnapshot(f.repo, { ...input, previous: merged.value, ...conflictPlan }, f.request);
    if (conflict.isErr()) throw conflict.error;
    expect(conflict.value.conflicts).toContain('shared');
    const conflictText = await read(conflict.value.worktreeCommit, 'shared');
    expect(conflictText).toContain('<<<<<<< cloud\nONE');
    expect(conflictText).toContain('=======\nDIFFERENT');
    const noopPlan = await planSnapshotMerge(reader, conflict.value, conflict.value, conflict.value);
    const noop = await writeArtifactsSnapshot(f.repo, { ...input, previous: conflict.value, ...noopPlan }, f.request);
    if (noop.isErr()) throw noop.error;
    expect(noop.value).toEqual(conflict.value);
    const pointer = (oid: string) => `version https://git-lfs.github.com/spec/v1\noid sha256:${oid.repeat(64)}\nsize 10\n`;
    const lfsBase = await snapshot({ asset: pointer('a') }), lfsCloud = await snapshot({ asset: pointer('b') }), lfsMachine = await snapshot({ asset: pointer('c') });
    const lfsPlan = await planSnapshotMerge(reader, lfsBase, lfsCloud, lfsMachine);
    expect(lfsPlan.conflicts).toContain('asset');
    expect(lfsPlan.mutations.some(mutation => mutation.path === 'asset')).toBe(false);
    const preserved = lfsPlan.mutations.find(mutation => mutation.path.startsWith('asset.gitspace-machine-'));
    expect(preserved?.oid).toBeDefined();
    if (!preserved?.oid) throw new Error('Incoming LFS pointer was not preserved');
    expect(new TextDecoder().decode((await git.readBlob({ fs, dir: f.dir, oid: preserved.oid })).blob)).toBe(pointer('c'));
  } finally { await f.close(); }
});

for (const resolution of ['cache', 'cloud'] as const) for (const replacement of ['text', 'delete', 'binary'] as const) test(`${resolution} ${replacement} clean publication clears resolved conflicts while retaining untouched markers`, async () => {
  const f = await fixture();
  const journal = new ExecutorJournal(join(f.dir, 'executor.sqlite'));
  try {
    const reader = { ...f.repo, readBlob: async (oid: string) => new Blob([Uint8Array.from((await git.readBlob({ fs, dir: f.dir, oid })).blob)]) };
    const snapshot = async (files: Record<string, string>): Promise<RuntimeGitCheckpoint> => {
      const tree = await git.writeTree({ fs, dir: f.dir, tree: await Promise.all(Object.entries(files).map(async ([path, value]) => ({ path, mode: '100644', type: 'blob' as const, oid: await git.writeBlob({ fs, dir: f.dir, blob: text.encode(value) }) }))) });
      const commit = await git.writeCommit({ fs, dir: f.dir, commit: { tree, parent: [f.previous.worktreeCommit], author, committer: author, message: 'conflict fixture\n' } });
      return { ...f.previous, worktreeTree: tree, worktreeCommit: commit, trackedWorktreeCommit: commit };
    };
    const base = await snapshot({ resolved: 'base\n', untouched: 'base\n' });
    const cloud = await snapshot({ resolved: 'cloud\n', untouched: 'cloud\n' });
    const machine = await snapshot({ resolved: 'machine\n', untouched: 'machine\n' });
    await git.writeRef({ fs, dir: f.dir, ref: cloud.checkpointRef, value: cloud.worktreeCommit, force: true });
    const conflicted = await writeArtifactsSnapshot(f.repo, { repository: 'fixture', workspaceId: 'workspace', previous: cloud, ...await planSnapshotMerge(reader, base, cloud, machine) }, f.request);
    if (conflicted.isErr()) throw conflicted.error;
    expect(conflicted.value.conflicts).toEqual(['resolved', 'untouched']);
    let accepted = conflicted.value;
    const attachment = RuntimeAttachmentSchema.parse({ attachmentId: 'attachment', projectId: 'project', workspaceId: 'workspace', machineId: 'machine', generation: 1, role: 'cache', checkout: { kind: 'shared', branch: 'main' }, state: 'ready', capabilities: ['checkpoint'], updatedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() });
    journal.installAttachment({ attachment, rootPath: f.dir, executionSecret: Buffer.alloc(32, 7).toString('base64url'), prerequisitesComplete: true });
    const executor = new MachineExecutor({ machineId: 'machine', journal, onMutationSettled: async () => accepted, runCommand: async () => { throw new Error('Checkpoint must not launch a command'); }, artifacts: () => ({ read: async () => [], write: async () => {} }) });
    const agentResult = async (checkpoint: RuntimeGitCheckpoint) => {
      accepted = checkpoint;
      return executor.execute(RuntimeToolDispatchSchema.parse({ conversationKind: 'main', version: 1, conversationId: 'conversation', taskId: 'task', attachmentId: 'attachment', projectId: 'project', workspaceId: 'workspace', machineId: 'machine', generation: 1, requestId: checkpoint.worktreeCommit, attemptId: checkpoint.worktreeCommit, tool: 'checkpoint', args: {}, deadlineAt: new Date(Date.now() + 60_000).toISOString(), replay: 'unsafe' }));
    };
    const initialNotice = (await agentResult(conflicted.value)).content.slice(1);
    expect(initialNotice).toEqual([expect.objectContaining({ type: 'text', text: expect.stringContaining('resolved') })]);
    expect(initialNotice).toEqual([expect.objectContaining({ text: expect.stringContaining('untouched') })]);
    const read = async (checkpoint: RuntimeGitCheckpoint, path: string) => new TextDecoder().decode((await git.readBlob({ fs, dir: f.dir, oid: checkpoint.worktreeCommit, filepath: path })).blob);
    const markers = await read(conflicted.value, 'untouched');
    expect(markers).toContain('<<<<<<< cloud\n');
    const clean = replacement === 'binary' ? '\0resolved\u00ff' : 'resolved\n';
    const publish = async (previous: RuntimeGitCheckpoint, path: string) => {
      const files: Record<string, string> = { untouched: await read(previous, 'untouched') };
      if (replacement !== 'delete' || path === 'resolved') files.resolved = await read(previous, 'resolved');
      const entries = Object.fromEntries(Object.entries(files).filter(([name]) => replacement !== 'delete' || name !== path).map(([name, content]) => [name, name === path ? clean : content]));
      const plan = resolution === 'cache'
        ? await planSnapshotMerge(reader, previous, previous, await snapshot(entries))
        : { mutations: [{ path, content: replacement === 'delete' ? null : text.encode(clean) }] };
      const result = await writeArtifactsSnapshot(f.repo, { repository: 'fixture', workspaceId: 'workspace', previous, ...plan }, f.request);
      if (result.isErr()) throw result.error;
      return result.value;
    };
    const partial = await publish(conflicted.value, 'resolved');
    if (replacement === 'delete') await expect(read(partial, 'resolved')).rejects.toThrow();
    else expect(await read(partial, 'resolved')).toBe(clean);
    expect(await read(partial, 'untouched')).toBe(markers);
    expect(partial.conflicts).toEqual(['untouched']);
    expect(partial.headCommit).toBe(base.headCommit);
    const partialNotice = (await agentResult(partial)).content.slice(1);
    expect(partialNotice).toEqual([expect.objectContaining({ type: 'text', text: expect.stringContaining('untouched') })]);
    expect(partialNotice).toEqual([expect.objectContaining({ text: expect.not.stringContaining('resolved') })]);
    const resolved = await publish(partial, 'untouched');
    const safety = { ...resolved, conflicts: ['HEAD', 'resolved'] };
    const untouched = await planSnapshotMerge(reader, safety, safety, safety);
    expect(untouched.conflicts).toEqual(['HEAD', 'resolved']);
    const explicit = await writeArtifactsSnapshot(f.repo, { repository: 'fixture', workspaceId: 'workspace', previous: safety, mutations: [{ path: 'resolved', content: text.encode('resolved\n') }] }, f.request);
    if (explicit.isErr()) throw explicit.error;
    expect(explicit.value.conflicts).toEqual(['HEAD']);
    expect(explicit.value.headCommit).toBe(base.headCommit);
    expect(resolved.conflicts).toEqual([]);
    expect(resolved.headCommit).toBe(base.headCommit);
    expect((await agentResult(resolved)).content).toEqual([{ type: 'text', text: JSON.stringify({ checkpoint: resolved }) }]);
  } finally { journal.close(); await f.close(); }
});

for (const publication of ['cloud', 'cache'] as const) test(`${publication} publication introduces conflict flags for marker content and clears them only after resolution`, async () => {
  const f = await fixture();
  try {
    const reader = { ...f.repo, readBlob: async (oid: string) => new Blob([Uint8Array.from((await git.readBlob({ fs, dir: f.dir, oid })).blob)]) };
    const publish = async (previous: RuntimeGitCheckpoint, content: string) => {
      const mutations = [{ path: 'script', content: text.encode(content) }];
      const blob = await git.writeBlob({ fs, dir: f.dir, blob: text.encode(content) });
      const entries = (await git.readTree({ fs, dir: f.dir, oid: previous.worktreeTree })).tree.map(entry => entry.path === 'script' ? { ...entry, oid: blob } : entry);
      const tree = await git.writeTree({ fs, dir: f.dir, tree: entries });
      const commit = await git.writeCommit({ fs, dir: f.dir, commit: { tree, parent: [previous.worktreeCommit], author, committer: author, message: 'cache edit\n' } });
      const machine = { ...previous, worktreeTree: tree, worktreeCommit: commit, trackedWorktreeCommit: commit };
      const plan = publication === 'cache' ? await planSnapshotMerge(reader, previous, previous, machine) : { mutations };
      const result = await writeArtifactsSnapshot(f.repo, { repository: 'fixture', workspaceId: 'workspace', previous, ...plan }, f.request);
      if (result.isErr()) throw result.error;
      expect(new TextDecoder().decode((await git.readBlob({ fs, dir: f.dir, oid: result.value.worktreeCommit, filepath: 'script' })).blob)).toBe(content);
      return result.value;
    };
    const marked = await publish(f.previous, 'text prefix\n<<<<<<< cloud\nours\n||||||| base\nbefore\n=======\ntheirs\n>>>>>>> machine\n');
    expect(marked.conflicts).toEqual(['script']);
    const partial = await publish(marked, 'ours\n>>>>>>> machine\n');
    expect(partial.conflicts).toEqual(['script']);
    const clean = await publish(partial, 'resolved\n');
    expect(clean.conflicts).toEqual([]);
    expect(clean.headCommit).toBe(f.previous.headCommit);
    expect(clean.indexCommit).toBe(f.previous.indexCommit);
  } finally { await f.close(); }
});

test('first machine publication creates the canonical ref even when all uploaded trees are unchanged', async () => {
  const f = await fixture();
  try {
    await git.deleteRef({ fs, dir: f.dir, ref: f.previous.checkpointRef });
    const machine = { ...f.previous, checkpointRef: 'refs/gitspace/machines/cache/checkpoints' };
    await git.writeRef({ fs, dir: f.dir, ref: machine.checkpointRef, value: machine.worktreeCommit });
    const input = { repository: 'fixture', workspaceId: 'workspace', previous: machine, machine, mutations: [], forcePublication: true };
    const accepted = await writeArtifactsSnapshot(f.repo, input, f.request);
    if (accepted.isErr()) throw accepted.error;
    expect(await git.resolveRef({ fs, dir: f.dir, ref: f.previous.checkpointRef })).toBe(accepted.value.worktreeCommit);
    expect(accepted.value.checkpointRef).toBe(f.previous.checkpointRef);
    expect(accepted.value.worktreeTree).toBe(machine.worktreeTree);
    expect(accepted.value.headCommit).toBe(machine.headCommit);
    expect(accepted.value.indexCommit).toBe(machine.indexCommit);
    const replay = await writeArtifactsSnapshot(f.repo, input, f.request);
    if (replay.isErr()) throw replay.error;
    expect(replay.value).toEqual(accepted.value);
  } finally { await f.close(); }
});

for (const publication of ['initial', 'recovery'] as const) test(`${publication} machine publication discovers unchanged conflict markers without metadata`, async () => {
  const f = await fixture();
  try {
    const markers = '<<<<<<< cloud\nours\n=======\ntheirs\n>>>>>>> machine\n';
    const blob = await git.writeBlob({ fs, dir: f.dir, blob: text.encode(markers) });
    const nested = await git.writeTree({ fs, dir: f.dir, tree: [{ path: 'conflict', mode: '100644', type: 'blob', oid: blob }] });
    const tree = await git.writeTree({ fs, dir: f.dir, tree: [{ path: 'nested', mode: '040000', type: 'tree', oid: nested }] });
    const commit = await git.writeCommit({ fs, dir: f.dir, commit: { tree, parent: [f.previous.worktreeCommit], author, committer: author, message: 'Existing markers without metadata\n' } });
    const checkpoint = { ...f.previous, worktreeCommit: commit, trackedWorktreeCommit: commit, worktreeTree: tree, conflicts: [] };
    await git.writeRef({ fs, dir: f.dir, ref: checkpoint.checkpointRef, value: commit, force: true });
    const plan = publication === 'initial'
      ? { machine: checkpoint, mutations: [], forcePublication: true }
      : await planSnapshotMerge(f.repo, checkpoint, checkpoint, checkpoint, { forcePublication: true });
    const input = { repository: 'fixture', workspaceId: 'workspace', previous: checkpoint, ...plan };
    const accepted = await writeArtifactsSnapshot(f.repo, input, f.request);
    if (accepted.isErr()) throw accepted.error;
    expect(accepted.value.conflicts).toEqual(['nested/conflict']);
    expect(accepted.value.worktreeTree).toBe(tree);
    expect(accepted.value.headCommit).toBe(checkpoint.headCommit);
    expect(accepted.value.indexCommit).toBe(checkpoint.indexCommit);
    const replay = await writeArtifactsSnapshot(f.repo, input, f.request);
    if (replay.isErr()) throw replay.error;
    expect(replay.value).toEqual(accepted.value);
  } finally { await f.close(); }
}, 5000);

for (const publication of ['initial', 'recovery', 'no-inventory'] as const) test(`${publication} merge-planned complete marker rescan drops deleted and clean conflicts instead of retaining checkpoint flags`, async () => {
  const f = await fixture();
  try {
    const clean = await git.writeBlob({ fs, dir: f.dir, blob: text.encode('resolved text\n') });
    const marked = await git.writeBlob({ fs, dir: f.dir, blob: text.encode('<<<<<<< cloud\nunresolved\n=======\ntheirs\n>>>>>>> machine\n') });
    const tree = await git.writeTree({ fs, dir: f.dir, tree: [
      { path: 'script', mode: '100644', type: 'blob', oid: clean },
      { path: 'still-marked', mode: '100644', type: 'blob', oid: marked },
    ] });
    const commit = await git.writeCommit({ fs, dir: f.dir, commit: { tree, parent: [f.previous.worktreeCommit], author, committer: author, message: 'Recovered worktree with stale conflict flags\n' } });
    const checkpoint = { ...f.previous, worktreeCommit: commit, trackedWorktreeCommit: commit, worktreeTree: tree, conflicts: ['removed', 'script', 'still-marked'] };
    await git.writeRef({ fs, dir: f.dir, ref: checkpoint.checkpointRef, value: commit, force: true });
    const plan = publication === 'no-inventory'
      ? { machine: checkpoint, mutations: [] }
      : await planSnapshotMerge(f.repo, checkpoint, checkpoint, checkpoint, { forcePublication: true });
    if (publication === 'initial') await git.deleteRef({ fs, dir: f.dir, ref: checkpoint.checkpointRef });
    const result = await writeArtifactsSnapshot(f.repo, { repository: 'fixture', workspaceId: 'workspace', previous: checkpoint, ...plan }, f.request);
    if (result.isErr()) throw result.error;
    expect(result.value.conflicts).toEqual(['still-marked']);
  } finally { await f.close(); }
});

test('ordinary marker scanning reads only the changed blob in a large tree', async () => {
  const f = await fixture();
  try {
    const unchanged = await git.writeBlob({ fs, dir: f.dir, blob: text.encode('unchanged\n') });
    const changed = await git.writeBlob({ fs, dir: f.dir, blob: text.encode('<<<<<<< cloud\nchanged\n') });
    const entries = Array.from({ length: 1000 }, (_, index) => ({ path: `file-${index}`, mode: '100644', type: 'blob' as const, oid: unchanged }));
    const tree = await git.writeTree({ fs, dir: f.dir, tree: entries });
    const nextTree = await git.writeTree({ fs, dir: f.dir, tree: entries.map(entry => entry.path === 'file-0' ? { ...entry, oid: changed } : entry) });
    const base = { ...f.previous, worktreeTree: tree };
    const reads: string[] = [];
    const reader = { ...f.repo, readBlob: async (oid: string) => { reads.push(oid); return f.repo.readBlob(oid); } };
    const plan = await planSnapshotMerge(reader, base, base, { ...base, worktreeTree: nextTree });
    expect(plan.conflicts).toEqual(['file-0']);
    expect(reads).toEqual([changed]);
  } finally { await f.close(); }
});

for (const publication of ['cloud', 'cache', 'initial', 'recovery'] as const) test(`${publication} marker scanning ignores non-text marker-like objects`, async () => {
  const f = await fixture();
  try {
    const marker = '<<<<<<< cloud\nours\n=======\ntheirs\n>>>>>>> machine\n';
    const oversized = new Uint8Array(8 * 1024 * 1024 + 1).fill(97);
    oversized.set(text.encode(marker));
    const mutations = [
      { path: 'binary', content: text.encode(`\0\n${marker}`) },
      { path: 'invalid-utf8', content: new Uint8Array([255, 10, ...text.encode(marker)]) },
      { path: 'lfs', content: text.encode(`version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 123\n${marker}`) },
      { path: 'oversized', content: oversized },
      { path: 'symlink', content: text.encode(marker), mode: '120000' },
      { path: 'real-text', content: text.encode(marker) },
    ];
    const entries = await Promise.all(mutations.map(async mutation => ({ path: mutation.path, mode: mutation.mode ?? '100644', type: 'blob' as const, oid: await git.writeBlob({ fs, dir: f.dir, blob: mutation.content }) })));
    const tree = await git.writeTree({ fs, dir: f.dir, tree: entries });
    const machine = { ...f.previous, worktreeTree: tree };
    if (publication === 'recovery') {
      const recovered = await planSnapshotMerge(f.repo, machine, machine, machine, { forcePublication: true });
      expect(recovered.conflicts).toEqual(['real-text']);
      return;
    }
    const plan = publication === 'cache'
      ? await planSnapshotMerge(f.repo, f.previous, f.previous, machine)
      : publication === 'initial' ? { machine, mutations } : { mutations };
    const result = await writeArtifactsSnapshot(f.repo, { repository: 'fixture', workspaceId: 'workspace', previous: f.previous, ...plan }, f.request);
    if (result.isErr()) throw result.error;
    expect(result.value.conflicts).toEqual(['real-text']);
  } finally { await f.close(); }
}, 10000);
