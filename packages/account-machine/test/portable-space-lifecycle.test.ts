import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spaceCheckpointManifestKey } from '@gitspace/protocol';
import {
  EncryptedCheckpointBlobStore,
  FileCheckpointBlobStore,
  PortableSpaceLifecycle,
  type PortableSpaceRuntime,
  type SpaceCheckpointAuthority,
  type SpaceGitCheckpointRemote,
  type WalgitProjectBinding,
} from '../src/index.js';

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

class TestAuthority implements SpaceCheckpointAuthority {
  state: 'open' | 'closing' | 'closed' | 'opening' = 'open';
  revision = 0;
  manifestKey?: string;
  manifestHash?: `sha256:${string}`;
  error?: string;

  async beginClose() {
    if (this.state !== 'open') throw new Error(`Cannot close from ${this.state}`);
    this.state = 'closing';
    this.revision += 1;
    return { revision: this.revision, previousRevision: this.revision === 1 ? null : this.revision - 1 };
  }
  async commitClosed(input: { manifestKey: string; manifestHash: `sha256:${string}` }) {
    if (this.state !== 'closing') throw new Error('Not closing');
    this.manifestKey = input.manifestKey;
    this.manifestHash = input.manifestHash;
    this.state = 'closed';
  }
  async abortClose(input: { message: string }) {
    this.error = input.message;
    this.state = 'open';
  }
  async beginOpen() {
    if (this.state !== 'closed' || !this.manifestKey || !this.manifestHash) throw new Error('Not closed');
    this.state = 'opening';
    return { revision: this.revision, manifestKey: this.manifestKey, manifestHash: this.manifestHash };
  }
  async commitOpen() { this.state = 'open'; }
  async failOpen(input: { message: string }) { this.error = input.message; }
}

class BareGitRemote implements SpaceGitCheckpointRemote {
  constructor(private readonly remote: string, private readonly failPublish = false) {}
  async publishCheckpoint(input: { repositoryPath: string; checkpointRef: string }): Promise<void> {
    if (this.failPublish) throw new Error('object store unavailable');
    git(input.repositoryPath, 'push', this.remote, `${input.checkpointRef}:${input.checkpointRef}`);
  }
  async fetchCheckpoint(input: { repositoryPath: string; checkpointRef: string }): Promise<void> {
    git(input.repositoryPath, 'fetch', this.remote, `${input.checkpointRef}:${input.checkpointRef}`);
  }
}

class TestRuntime implements PortableSpaceRuntime {
  quiesced = false;
  resumed = false;
  active = false;
  restoredAgent?: { sessionId: string; ompSessionId: string; ompSession: Uint8Array };
  restoredArtifacts?: { generation: number; manifest: Uint8Array };

  constructor(private readonly repositoryPath: string, private readonly deleteRepository: boolean) {}
  async quiesce() { this.quiesced = true; }
  async resumeAfterFailedClose() { this.quiesced = false; this.resumed = true; }
  async captureAgent() {
    return {
      sessionId: 'session-a',
      ompSessionId: 'omp-a',
      ompSession: new TextEncoder().encode('omp checkpoint'),
    };
  }
  async captureArtifacts() {
    return { generation: 3, manifest: new TextEncoder().encode('{"files":["report.txt"]}') };
  }
  async deleteLocalState() {
    if (this.deleteRepository) rmSync(this.repositoryPath, { recursive: true, force: true });
  }
  async prepareEmptyRepository() {
    mkdirSync(this.repositoryPath, { recursive: true });
    git(this.repositoryPath, 'init', '-b', 'main');
  }
  async restoreAgent(input: { sessionId: string; ompSessionId: string; ompSession: Uint8Array }) {
    this.restoredAgent = input;
  }
  async restoreArtifacts(input: { generation: number; manifest: Uint8Array }) { this.restoredArtifacts = input; }
  async activate() { this.active = true; }
  prompt(text: string): string {
    if (!this.active || !this.restoredAgent) throw new Error('Agent is not restored');
    return `${new TextDecoder().decode(this.restoredAgent.ompSession)}:${text}`;
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-portable-space-'));
  roots.push(root);
  const source = join(root, 'source');
  const target = join(root, 'target');
  const remote = join(root, 'remote.git');
  mkdirSync(source);
  git(source, 'init', '-b', 'main');
  writeFileSync(join(source, '.gitignore'), 'secret.env\n');
  writeFileSync(join(source, 'staged.txt'), 'base\n');
  writeFileSync(join(source, 'unstaged.txt'), 'base\n');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'base');
  writeFileSync(join(source, 'staged.txt'), 'staged\n');
  git(source, 'add', 'staged.txt');
  writeFileSync(join(source, 'unstaged.txt'), 'unstaged\n');
  writeFileSync(join(source, 'portable.txt'), 'portable\n');
  writeFileSync(join(source, 'secret.env'), 'secret\n');
  git(root, 'init', '--bare', remote);
  const binding: WalgitProjectBinding = { projectId: 'project-a', bucket: 'user-bucket', endpoint: 'https://example.invalid', region: 'auto' };
  return { root, source, target, remote, binding };
}

describe('PortableSpaceLifecycle', () => {
  it('closes only after durable state and reopens an agent from empty machine state', async () => {
    const { root, source, target, remote, binding } = fixture();
    const expectedStatus = git(source, 'status', '--porcelain=v1');
    const authority = new TestAuthority();
    const blobs = new EncryptedCheckpointBlobStore(new FileCheckpointBlobStore(join(root, 'bucket')), new Uint8Array(32).fill(7));
    const lifecycle = new PortableSpaceLifecycle(authority, blobs, new BareGitRemote(remote));
    const sourceRuntime = new TestRuntime(source, true);
    const closed = await lifecycle.close({ projectId: 'project-a', spaceId: 'space-a', machineId: 'machine-a', expectedGeneration: 1, repositoryPath: source, portableUntrackedPaths: ['portable.txt'], binding }, sourceRuntime);
    expect(authority.state).toBe('closed');
    expect(existsSync(source)).toBe(false);
    expect(closed.manifest.repository.branch).toBe('main');
    expect(authority.manifestKey).toBe(spaceCheckpointManifestKey('project-a', 'space-a', 1));
    const rawManifest = readFileSync(join(root, 'bucket', authority.manifestKey!));
    expect(rawManifest.includes(Buffer.from('session-a'))).toBe(false);

    const targetRuntime = new TestRuntime(target, false);
    await lifecycle.open({ projectId: 'project-a', spaceId: 'space-a', machineId: 'machine-b', expectedGeneration: 1, repositoryPath: target, portableUntrackedPaths: ['portable.txt'], binding }, targetRuntime);
    expect(authority.state).toBe('open');
    expect(git(target, 'status', '--porcelain=v1')).toBe(expectedStatus);
    expect(targetRuntime.restoredAgent).toMatchObject({ sessionId: 'session-a', ompSessionId: 'omp-a' });
    expect(targetRuntime.restoredArtifacts?.generation).toBe(3);
    expect(targetRuntime.prompt('continue')).toBe('omp checkpoint:continue');
    expect(existsSync(join(target, 'secret.env'))).toBe(false);
  });

  it('returns to open when publication fails and never commits closed state', async () => {
    const { root, source, remote, binding } = fixture();
    const authority = new TestAuthority();
    const lifecycle = new PortableSpaceLifecycle(
      authority,
      new EncryptedCheckpointBlobStore(new FileCheckpointBlobStore(join(root, 'bucket')), new Uint8Array(32).fill(9)),
      new BareGitRemote(remote, true),
    );
    const runtime = new TestRuntime(source, true);
    await expect(lifecycle.close({ projectId: 'project-a', spaceId: 'space-a', machineId: 'machine-a', expectedGeneration: 1, repositoryPath: source, portableUntrackedPaths: ['portable.txt'], binding }, runtime)).rejects.toThrow('object store unavailable');
    expect(authority.state).toBe('open');
    expect(runtime.resumed).toBe(true);
    expect(existsSync(source)).toBe(true);
    expect(authority.manifestKey).toBeUndefined();
  });

  it('resumes access and retains files when draining fails after partial quiescence', async () => {
    const { root, source, remote, binding } = fixture();
    const authority = new TestAuthority();
    const lifecycle = new PortableSpaceLifecycle(authority, new FileCheckpointBlobStore(join(root, 'bucket')), new BareGitRemote(remote));
    const runtime = new TestRuntime(source, true);
    runtime.quiesce = async () => { runtime.quiesced = true; throw new Error('Service drain failed'); };
    await expect(lifecycle.close({ projectId: 'project-a', spaceId: 'space-a', machineId: 'machine-a', expectedGeneration: 1, repositoryPath: source, binding }, runtime)).rejects.toThrow('Service drain failed');
    expect(runtime.resumed).toBeTrue();
    expect(authority.state).toBe('open');
    expect(readFileSync(join(source, 'unstaged.txt'), 'utf8')).toBe('unstaged\n');
    expect(authority.manifestKey).toBeUndefined();
  });

});
