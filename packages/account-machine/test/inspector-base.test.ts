import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spaceCheckpointManifestKey, spaceCheckpointManifestSchema, type SpaceCheckpointManifest } from '@gitspace/protocol-workspace';
import type { SpaceAuthorityRecord } from '@gitspace/protocol-workspace';
import { createGitIntermediateCheckpoint } from '../src/git-checkpoint.js';
import { createInspectorBaseResolver, type InspectorBaseResolverOptions } from '../src/inspector-base.js';
import { EncryptedCheckpointBlobStore, type CheckpointBlobStore } from '../src/portable-space-lifecycle.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: {
      ...Bun.env,
      GIT_AUTHOR_NAME: 'GitSpace Test',
      GIT_AUTHOR_EMAIL: 'test@gitspace.invalid',
      GIT_COMMITTER_NAME: 'GitSpace Test',
      GIT_COMMITTER_EMAIL: 'test@gitspace.invalid',
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

class MemoryBlobs implements CheckpointBlobStore {
  readonly objects = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array): Promise<`sha256:${string}`> {
    this.objects.set(key, bytes);
    return `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`;
  }

  async get(key: string, expectedHash?: string): Promise<Uint8Array | null> {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    if (expectedHash && expectedHash !== `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`) {
      throw new Error('Checkpoint integrity verification failed');
    }
    return bytes;
  }
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-inspector-base-'));
  roots.push(root);
  const source = join(root, 'base');
  const target = join(root, 'inspected');
  const remotePath = join(root, 'objects.git');
  mkdirSync(source);
  git(source, 'init', '-b', 'main');
  writeFileSync(join(source, 'shared.txt'), 'original\n');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'original');
  git(root, 'clone', '--no-local', source, target);
  git(target, 'remote', 'remove', 'origin');
  git(target, 'switch', '-c', 'workspace');
  writeFileSync(join(target, 'workspace.txt'), 'committed workspace\n');
  git(target, 'add', '.');
  git(target, 'commit', '-m', 'workspace');
  writeFileSync(join(target, 'workspace.txt'), 'staged workspace\n');
  git(target, 'add', 'workspace.txt');
  writeFileSync(join(target, 'workspace.txt'), 'unstaged workspace\n');
  writeFileSync(join(target, 'untracked.txt'), 'local only\n');

  writeFileSync(join(source, 'shared.txt'), 'saved branch\n');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'unpublished base branch');
  writeFileSync(join(source, 'shared.txt'), 'staged snapshot\n');
  git(source, 'add', 'shared.txt');
  writeFileSync(join(source, 'shared.txt'), 'unstaged snapshot\n');
  git(root, 'init', '--bare', remotePath);

  const blobs = new MemoryBlobs();
  const authority = {
    record: null as SpaceAuthorityRecord | null,
    async getSpace(): Promise<SpaceAuthorityRecord | null> {
      return this.record ? { ...this.record } : null;
    },
  };
  const remote = {
    fetches: 0,
    beforeFetch: undefined as (() => Promise<void>) | undefined,
    async fetchCheckpoint(input: Parameters<InspectorBaseResolverOptions['gitRemote']['fetchCheckpoint']>[0]) {
      this.fetches += 1;
      await this.beforeFetch?.();
      git(input.repositoryPath, 'fetch', remotePath, `${input.checkpointRef}:${input.checkpointRef}`);
    },
  };
  const options: InspectorBaseResolverOptions = {
    authority,
    blobs,
    gitRemote: remote,
    binding: (projectId) => ({ projectId, bucket: 'account-storage', endpoint: 'https://storage.invalid', region: 'auto' }),
  };
  const input = { projectId: 'project-a', baseSpaceId: 'base-a', baseBranch: 'main', repositoryPath: target };

  async function saveManifest(manifest: unknown, revision: number): Promise<void> {
    const manifestKey = spaceCheckpointManifestKey(input.projectId, input.baseSpaceId, revision);
    const manifestHash = await blobs.put(manifestKey, new TextEncoder().encode(JSON.stringify(manifest)));
    authority.record = {
      projectId: input.projectId,
      spaceId: input.baseSpaceId,
      state: 'closed',
      machineId: null,
      generation: revision,
      checkpointRevision: revision,
      manifestKey,
      manifestHash,
      failures: { open: null, close: null },
      revision,
      publishedRevision: revision,
      resumeMachineId: null,
      updatedAt: '2026-09-08T00:00:00.000Z',
    };
  }

  async function publish(revision: number): Promise<SpaceCheckpointManifest> {
    const checkpoint = await createGitIntermediateCheckpoint({ repositoryPath: source, spaceId: input.baseSpaceId, revision });
    git(source, 'push', remotePath, `${checkpoint.checkpointRef}:${checkpoint.checkpointRef}`);
    const manifest = spaceCheckpointManifestSchema.parse({
      version: 1,
      projectId: input.projectId,
      spaceId: input.baseSpaceId,
      revision,
      previousRevision: revision === 1 ? null : revision - 1,
      repository: checkpoint,
      agent: { sessionId: 'session-a', ompSessionId: 'omp-a', ompCheckpointHash: `sha256:${'1'.repeat(64)}` },
      artifacts: { manifestHash: `sha256:${'2'.repeat(64)}`, generation: 0 },
      createdAt: '2026-09-08T00:00:00.000Z',
    });
    await saveManifest(manifest, revision);
    return manifest;
  }

  const manifest = await publish(1);
  return { root, source, target, blobs, authority, remote, options, input, manifest, publish, saveManifest, resolveBase: createInspectorBaseResolver(options) };
}

function checkoutState(repositoryPath: string) {
  return {
    head: git(repositoryPath, 'rev-parse', 'HEAD'),
    branch: git(repositoryPath, 'symbolic-ref', 'HEAD'),
    index: readFileSync(join(repositoryPath, '.git', 'index')),
    shared: readFileSync(join(repositoryPath, 'shared.txt'), 'utf8'),
    tracked: readFileSync(join(repositoryPath, 'workspace.txt'), 'utf8'),
    untracked: readFileSync(join(repositoryPath, 'untracked.txt'), 'utf8'),
  };
}

describe('Inspector saved base resolver', () => {
  it('fetches the saved branch head without a base checkout and preserves the inspected checkout and index', async () => {
    const f = await fixture();
    const encrypted = new EncryptedCheckpointBlobStore(f.blobs, new Uint8Array(32).fill(7));
    f.authority.record!.manifestHash = await encrypted.put(f.authority.record!.manifestKey!, new TextEncoder().encode(JSON.stringify(f.manifest)));
    const resolveBase = createInspectorBaseResolver({ ...f.options, blobs: encrypted });
    const before = checkoutState(f.target);
    rmSync(f.source, { recursive: true, force: true });

    const head = await resolveBase(f.input);

    expect(head).toBe(f.manifest.repository.headCommit);
    expect(git(f.target, 'show', `${head}:shared.txt`)).toBe('saved branch');
    expect(git(f.target, 'show', `${f.manifest.repository.indexCommit}:shared.txt`)).toBe('staged snapshot');
    expect(git(f.target, 'show', `${f.manifest.repository.worktreeCommit}:shared.txt`)).toBe('unstaged snapshot');
    expect(git(f.target, 'merge-base', 'HEAD', head)).toBe(git(f.target, 'rev-parse', 'HEAD^'));
    expect(checkoutState(f.target)).toEqual(before);
    expect(existsSync(f.source)).toBe(false);
  });

  it('uses existing commit objects when checkpoint storage is unreachable', async () => {
    const f = await fixture();
    await f.remote.fetchCheckpoint({ binding: f.options.binding(f.input.projectId), repositoryPath: f.target, checkpointRef: f.manifest.repository.checkpointRef });
    f.remote.beforeFetch = async () => { throw new Error('checkpoint storage offline'); };
    await expect(f.resolveBase(f.input)).resolves.toBe(f.manifest.repository.headCommit);
  });

  it('observes the newest published checkpoint of an open base rather than its live HEAD', async () => {
    const f = await fixture();
    await expect(f.resolveBase(f.input)).resolves.toBe(f.manifest.repository.headCommit);
    writeFileSync(join(f.source, 'shared.txt'), 'new saved branch\n');
    git(f.source, 'add', '.');
    git(f.source, 'commit', '-m', 'new saved base');
    const latest = await f.publish(2);
    f.authority.record!.state = 'open';
    f.authority.record!.machineId = 'another-machine';
    writeFileSync(join(f.source, 'shared.txt'), 'not checkpointed\n');
    git(f.source, 'add', '.');
    git(f.source, 'commit', '-m', 'live base ahead of checkpoint');

    await expect(f.resolveBase(f.input)).resolves.toBe(latest.repository.headCommit);
    expect(git(f.target, 'show', `${latest.repository.headCommit}:shared.txt`)).toBe('new saved branch');
  });

  it('keeps the published checkpoint available during a new close and after that close fails', async () => {
    const f = await fixture();
    f.authority.record!.state = 'closing';
    f.authority.record!.checkpointRevision = 2;
    await expect(f.resolveBase(f.input)).resolves.toBe(f.manifest.repository.headCommit);

    f.authority.record!.state = 'open';
    f.authority.record!.failures.close = { domain: 'workspace', code: 'WORKSPACE_CHECKPOINT_FAILED', message: 'checkpoint publication failed', context: {} };
    await expect(f.resolveBase(f.input)).resolves.toBe(f.manifest.repository.headCommit);
  });

  it('fails explicitly when the base placement or its published manifest is unavailable', async () => {
    const f = await fixture();
    const record = { ...f.authority.record! };
    f.authority.record = null;
    await expect(f.resolveBase(f.input)).rejects.toThrow(/base.*unavailable/i);
    f.authority.record = { ...record, checkpointRevision: 0, manifestKey: null, manifestHash: null };
    await expect(f.resolveBase(f.input)).rejects.toThrow(/no published repository checkpoint/i);
    f.authority.record = record;
    f.blobs.objects.delete(record.manifestKey!);
    await expect(f.resolveBase(f.input)).rejects.toThrow(/manifest.*missing/i);
  });

  it('rejects corrupted manifests and mismatched checkpoint identities before fetching Git objects', async () => {
    const f = await fixture();
    f.blobs.objects.set(f.authority.record!.manifestKey!, new TextEncoder().encode('{}'));
    await expect(f.resolveBase(f.input)).rejects.toThrow(/integrity/i);

    const invalid = [
      { ...f.manifest, projectId: 'another-project' },
      { ...f.manifest, spaceId: 'another-base' },
      { ...f.manifest, revision: 2 },
      { ...f.manifest, repository: { ...f.manifest.repository, headCommit: 'HEAD' } },
      { ...f.manifest, repository: { ...f.manifest.repository, checkpointRef: 'refs/heads/workspace' } },
    ];
    for (const manifest of invalid) {
      await f.saveManifest(manifest, 1);
      await expect(f.resolveBase(f.input)).rejects.toThrow(/base.*unavailable/i);
    }
    await f.saveManifest(f.manifest, 1);
    await expect(f.resolveBase({ ...f.input, baseBranch: 'new-default' })).rejects.toThrow(/branch.*does not match/i);
    expect(f.remote.fetches).toBe(0);
  });

  it('rejects non-commit branch heads and a saved head absent from the published checkpoint', async () => {
    const f = await fixture();
    await f.saveManifest({ ...f.manifest, repository: { ...f.manifest.repository, headCommit: git(f.target, 'rev-parse', 'HEAD^{tree}') } }, 1);
    await expect(f.resolveBase(f.input)).rejects.toThrow(/not a Git commit/i);
    const missingHead = 'f'.repeat(40);
    await f.saveManifest({ ...f.manifest, repository: { ...f.manifest.repository, headCommit: missingHead } }, 1);
    await expect(f.resolveBase(f.input)).rejects.toThrow(/does not contain saved branch head/i);
  });

  it('deduplicates concurrent fetches per checkout and retries after a shared failure', async () => {
    const f = await fixture();
    const otherTarget = join(f.root, 'other-inspected');
    git(f.root, 'clone', '--no-local', f.target, otherTarget);
    f.remote.beforeFetch = async () => { throw new Error('checkpoint storage offline'); };
    const inputs = [f.input, f.input, { ...f.input, repositoryPath: otherTarget }, { ...f.input, repositoryPath: otherTarget }];
    const failed = await Promise.allSettled(inputs.map((input) => f.resolveBase(input)));
    expect(failed.map((result) => result.status)).toEqual(['rejected', 'rejected', 'rejected', 'rejected']);
    expect(f.remote.fetches).toBe(2);

    f.remote.beforeFetch = undefined;
    await expect(Promise.all(inputs.map((input) => f.resolveBase(input)))).resolves.toEqual(inputs.map(() => f.manifest.repository.headCommit));
    expect(f.remote.fetches).toBe(4);
    expect(git(f.target, 'cat-file', '-t', f.manifest.repository.headCommit)).toBe('commit');
    expect(git(otherTarget, 'cat-file', '-t', f.manifest.repository.headCommit)).toBe('commit');
  });

  it('does not retain successful object lookups after the inspected checkout is replaced', async () => {
    const f = await fixture();
    await f.resolveBase(f.input);
    rmSync(f.target, { recursive: true, force: true });
    mkdirSync(f.target);
    git(f.target, 'init', '-b', 'replacement');

    await expect(f.resolveBase(f.input)).resolves.toBe(f.manifest.repository.headCommit);
    expect(git(f.target, 'cat-file', '-t', f.manifest.repository.headCommit)).toBe('commit');
    expect(git(f.target, 'symbolic-ref', 'HEAD')).toBe('refs/heads/replacement');
  });
});
