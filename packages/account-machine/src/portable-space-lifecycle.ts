import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import {
  CHECKPOINT_CHUNK_BYTES,
  CHUNKED_CHECKPOINT_VERSION,
  chunkedCheckpointManifestSchema,
  collectBytes,
  spaceArtifactManifestKey,
  spaceCheckpointManifestKey,
  parseWorkspaceCheckpoint,
  spaceOmpCheckpointKey,
  type SpaceCheckpointManifest,
  WorkspaceDomainError,
} from '@gitspace/protocol-workspace';
import { decryptArtifactBytes, encryptArtifactBytes } from '@gitspace/protocol';
import { createGitIntermediateCheckpoint, restoreGitIntermediateCheckpoint } from './git-checkpoint.js';
import type { ArtifactsRepositoryBinding } from './artifacts-git-remote.js';
import type { MachineGitLfsAccess } from './git-lfs.js';

export interface CheckpointBlobStore {
  put(key: string, bytes: Uint8Array): Promise<`sha256:${string}`>;
  get(key: string, expectedHash?: string, maxBytes?: number): Promise<Uint8Array | null>;
}


export class FileCheckpointBlobStore implements CheckpointBlobStore {
  constructor(private readonly root: string) {}

  async put(key: string, bytes: Uint8Array): Promise<`sha256:${string}`> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return hashBytes(bytes);
  }

  async get(key: string, expectedHash?: string, maxBytes = 64 * 1024 * 1024): Promise<Uint8Array | null> {
    try {
      const file = await open(this.path(key), 'r');
      let bytes: Uint8Array;
      try {
        if ((await file.stat()).size > maxBytes) throw new Error('Checkpoint ciphertext exceeds byte limit');
        bytes = await collectBytes(file.createReadStream({ autoClose: false }), maxBytes);
      } finally { await file.close(); }
      if (expectedHash && hashBytes(bytes) !== expectedHash) throw new Error(`Checkpoint object ${key} failed integrity verification`);
      return bytes;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  private path(key: string): string {
    const root = resolve(this.root);
    const path = resolve(root, key);
    const local = relative(root, path);
    if (local === '' || local === '..' || local.startsWith(`..${sep}`)) throw new Error(`Invalid checkpoint object key ${key}`);
    return path;
  }
}

export class EncryptedCheckpointBlobStore implements CheckpointBlobStore {
  constructor(private readonly inner: CheckpointBlobStore, private readonly key: Uint8Array) {
    if (key.byteLength !== 32) throw new RangeError('Checkpoint encryption key must be 32 bytes');
  }

  async put(key: string, bytes: Uint8Array): Promise<`sha256:${string}`> {
    return this.putStream(key, (async function* () { yield bytes; })(), bytes.byteLength);
  }

  async putStream(key: string, source: AsyncIterable<Uint8Array>, size: number): Promise<`sha256:${string}`> {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Checkpoint source size is invalid');
    if (128 + 128 * Math.ceil(size / CHECKPOINT_CHUNK_BYTES) > 64 * 1024 * 1024 - 30) throw new Error('Checkpoint inventory exceeds byte limit');
    const chunks: Array<{ hash: `sha256:${string}`; size: number }> = [];
    let buffer = new Uint8Array(Math.min(size, CHECKPOINT_CHUNK_BYTES));
    let filled = 0;
    let total = 0;
    for await (const input of source) {
      total += input.byteLength;
      if (total > size) throw new Error('Checkpoint source exceeds expected size');
      let offset = 0;
      while (offset < input.byteLength) {
        const count = Math.min(buffer.byteLength - filled, input.byteLength - offset);
        buffer.set(input.subarray(offset, offset + count), filled);
        filled += count;
        offset += count;
        if (filled === buffer.byteLength && size > CHECKPOINT_CHUNK_BYTES) {
          const sealed = await encryptArtifactBytes(buffer, this.key);
          const hash = hashBytes(sealed);
          if (await this.inner.put(`${key}.chunks/${hash.slice(7)}`, sealed) !== hash) throw new Error(`Checkpoint chunk for ${key} failed upload integrity verification`);
          chunks.push({ hash, size: filled });
          buffer = new Uint8Array(Math.max(0, Math.min(size - chunks.length * CHECKPOINT_CHUNK_BYTES, CHECKPOINT_CHUNK_BYTES)));
          filled = 0;
        }
      }
    }
    if (total !== size) throw new Error('Checkpoint source has an unexpected size');
    // Exhaustion also completes the caller's incremental plaintext integrity check.
    if (size <= CHECKPOINT_CHUNK_BYTES) return this.inner.put(key, await encryptArtifactBytes(buffer, this.key));
    const inventory = new TextEncoder().encode(JSON.stringify({ version: 1, size, chunks }));
    const sealed = await encryptArtifactBytes(inventory, this.key);
    const envelope = new Uint8Array(1 + sealed.byteLength);
    envelope[0] = CHUNKED_CHECKPOINT_VERSION;
    envelope.set(sealed, 1);
    return this.inner.put(key, envelope);
  }

  async get(key: string, expectedHash?: string, maxBytes = Number.MAX_SAFE_INTEGER): Promise<Uint8Array | null> {
    const source = await this.getStream(key, expectedHash);
    return source === null ? null : collectBytes(source, maxBytes);
  }

  async getStream(key: string, expectedHash?: string, expectedSize?: number): Promise<AsyncIterable<Uint8Array> | null> {
    const manifestLimit = expectedSize === undefined ? 64 * 1024 * 1024 : Math.min(64 * 1024 * 1024, 128 + 128 * Math.ceil(expectedSize / CHECKPOINT_CHUNK_BYTES));
    const limit = expectedSize === undefined ? manifestLimit : expectedSize <= CHECKPOINT_CHUNK_BYTES ? expectedSize + 29 : manifestLimit;
    const sealed = await this.inner.get(key, expectedHash, limit);
    if (!sealed) return null;
    if (sealed.byteLength > limit) throw new Error('Checkpoint ciphertext exceeds byte limit');
    const inner = this.inner;
    const encryptionKey = this.key;
    return (async function* () {
      if (sealed[0] !== CHUNKED_CHECKPOINT_VERSION) {
        const bytes = await decryptArtifactBytes(sealed, encryptionKey);
        if (expectedSize !== undefined && bytes.byteLength !== expectedSize) throw new Error('LFS inventory size does not match object');
        yield bytes;
        return;
      }
      const inventory = await decryptArtifactBytes(sealed.subarray(1), encryptionKey);
      const manifest = chunkedCheckpointManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(inventory)));
      if (expectedSize !== undefined && manifest.size !== expectedSize) throw new Error('LFS inventory size does not match object');
      for (const chunk of manifest.chunks) {
        const chunkKey = `${key}.chunks/${chunk.hash.slice(7)}`;
        const stored = await inner.get(chunkKey, chunk.hash, chunk.size + 29);
        if (!stored) throw new Error(`Checkpoint chunk ${chunkKey} is missing`);
        if (stored.byteLength !== chunk.size + 29 || hashBytes(stored) !== chunk.hash) throw new Error(`Checkpoint chunk ${chunkKey} failed integrity verification`);
        const plaintext = await decryptArtifactBytes(stored, encryptionKey);
        if (plaintext.byteLength !== chunk.size) throw new Error(`Checkpoint chunk ${chunkKey} has an unexpected size`);
        yield plaintext;
      }
    })();
  }
}

export interface SpaceCheckpointAuthority {
  beginClose(input: { projectId: string; spaceId: string; machineId: string; expectedGeneration: number }): Promise<{ revision: number; previousRevision: number | null }>;
  commitClosed(input: { projectId: string; spaceId: string; machineId: string; expectedGeneration: number; revision: number; manifestKey: string; manifestHash: `sha256:${string}`; resumeOnMachineRestart?: boolean }): Promise<void>;
  abortClose(input: { projectId: string; spaceId: string; machineId: string; expectedGeneration: number; revision: number; message: string }): Promise<void>;
  beginOpen(input: { projectId: string; spaceId: string; machineId: string; expectedGeneration: number; resumeOnMachineRestart?: boolean }): Promise<{ revision: number; manifestKey: string; manifestHash: `sha256:${string}` }>;
  commitOpen(input: { projectId: string; spaceId: string; machineId: string; expectedGeneration: number; revision: number }): Promise<void>;
  failOpen(input: { projectId: string; spaceId: string; machineId: string; expectedGeneration: number; revision: number; message: string }): Promise<void>;
}

export interface SpaceGitCheckpointRemote {
  publishCheckpoint(input: { binding: ArtifactsRepositoryBinding; repositoryPath: string; checkpointRef: string }): Promise<void>;
  fetchCheckpoint(input: { binding: ArtifactsRepositoryBinding; repositoryPath: string; checkpointRef: string }): Promise<void>;
}
export type PortableAgentSnapshot =
  | { kind: 'cloud'; sessionId: string; conversationId: string; cursor: number; resumePending?: boolean }
  | { kind: 'legacy'; sessionId: string; ompSessionId: string; ompSession: Uint8Array; resumePending?: boolean };

export interface PortableSpaceRuntime {
  quiesce(): Promise<void>;
  prepareLocalCleanup?(): Promise<void>;
  recordLocalCheckpoint?(receipt: { revision: number; manifestKey: string; manifestHash: `sha256:${string}` }): void;
  resumeAfterFailedClose(): Promise<void>;
  captureAgent(): Promise<PortableAgentSnapshot>;
  captureArtifacts(): Promise<{ generation: number; manifest: Uint8Array }>;
  deleteLocalState(): Promise<void>;
  prepareEmptyRepository(): Promise<void>;
  restoreAgent(input: PortableAgentSnapshot): Promise<void>;
  restoreArtifacts(input: { generation: number; manifest: Uint8Array }): Promise<void>;
  activate(): Promise<void>;
}

export interface PortableSpaceDescriptor {
  projectId: string;
  spaceId: string;
  machineId: string;
  expectedGeneration: number;
  repositoryPath: string;
  portableUntrackedPaths?: string[];
  resumeOnMachineRestart?: boolean;
  binding: ArtifactsRepositoryBinding;
}

export interface CloseSpaceResult {
  manifest: SpaceCheckpointManifest;
  warnings: string[];
}

export class PortableSpaceLifecycle {
  constructor(
    private readonly authority: SpaceCheckpointAuthority,
    private readonly blobs: CheckpointBlobStore,
    private readonly gitRemote: SpaceGitCheckpointRemote,
    private readonly lfs?: MachineGitLfsAccess,
  ) {}

  /** Checkpoint, hand the space back to the cloud, and delete the local copy. */
  async close(space: PortableSpaceDescriptor, runtime: PortableSpaceRuntime, resumeOnMachineRestart = false): Promise<CloseSpaceResult> {
    const manifest = await this.publishCheckpoint(space, runtime, resumeOnMachineRestart);
    const warnings: string[] = [];
    try {
      await runtime.deleteLocalState();
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
    return { manifest, warnings };
  }

  private async publishCheckpoint(space: PortableSpaceDescriptor, runtime: PortableSpaceRuntime, resumeOnMachineRestart: boolean): Promise<SpaceCheckpointManifest> {
    const identity = { projectId: space.projectId, spaceId: space.spaceId, machineId: space.machineId, expectedGeneration: space.expectedGeneration };
    const operation = await this.authority.beginClose(identity);
    let quiesced = false;
    const lfs = await this.lfs?.publish(space.projectId, `portable:${space.spaceId}:${operation.revision}`);
    try {
      quiesced = true;
      await runtime.quiesce();
      await runtime.prepareLocalCleanup?.();
      const repository = await createGitIntermediateCheckpoint({
        repositoryPath: space.repositoryPath,
        spaceId: space.spaceId,
        revision: operation.revision,
        portableUntrackedPaths: space.portableUntrackedPaths,
        lfs,
      });
      await this.gitRemote.publishCheckpoint({ binding: space.binding, repositoryPath: space.repositoryPath, checkpointRef: repository.checkpointRef });
      const [agent, artifacts] = await Promise.all([runtime.captureAgent(), runtime.captureArtifacts()]);
      const agentCheckpoint = agent.kind === 'cloud' ? agent : {
        kind: 'legacy' as const, sessionId: agent.sessionId, ompSessionId: agent.ompSessionId,
        ompCheckpointHash: await this.blobs.put(spaceOmpCheckpointKey(space.projectId, space.spaceId, operation.revision), agent.ompSession),
        resumePending: agent.resumePending ?? false,
      };
      const artifactManifestKey = spaceArtifactManifestKey(space.projectId, space.spaceId, operation.revision, artifacts.generation);
      const artifactManifestHash = await this.blobs.put(artifactManifestKey, artifacts.manifest);
      const manifest = parseWorkspaceCheckpoint({
        version: 1,
        projectId: space.projectId,
        spaceId: space.spaceId,
        revision: operation.revision,
        previousRevision: operation.previousRevision,
        repository: {
          checkpointRef: repository.checkpointRef,
          headCommit: repository.headCommit,
          branch: repository.branch,
          indexCommit: repository.indexCommit,
          worktreeCommit: repository.worktreeCommit,
          lfs: repository.lfs,
        },
        agent: agentCheckpoint,
        artifacts: { manifestHash: artifactManifestHash, generation: artifacts.generation },
        createdAt: new Date().toISOString(),
      });
      const manifestKey = spaceCheckpointManifestKey(space.projectId, space.spaceId, operation.revision);
      const manifestHash = await this.blobs.put(manifestKey, new TextEncoder().encode(JSON.stringify(manifest)));
      runtime.recordLocalCheckpoint?.({ revision: operation.revision, manifestKey, manifestHash });
      await this.authority.commitClosed({
        ...identity,
        revision: operation.revision,
        manifestKey,
        manifestHash,
        resumeOnMachineRestart,
      });
      await lfs?.releasePublication?.();
      return manifest;
    } catch (error) {
      const failures: unknown[] = [error];
      try { await this.authority.abortClose({ ...identity, revision: operation.revision, message: error instanceof Error ? error.message : String(error) }); }
      catch (abortError) { failures.push(abortError); }
      // A failed abort can mean commit succeeded but its response was lost.
      // Keep admissions fenced until the authority resolves that uncertainty.
      if (quiesced && failures.length === 1) {
        try { await runtime.resumeAfterFailedClose(); }
        catch (resumeError) { failures.push(resumeError); }
      }
      if (failures.length > 1) throw new AggregateError(failures, 'Space checkpoint and rollback failed');
      throw error;
    }
  }

  async open(space: PortableSpaceDescriptor, runtime: PortableSpaceRuntime, onClaimed?: () => void): Promise<SpaceCheckpointManifest> {
    const identity = { projectId: space.projectId, spaceId: space.spaceId, machineId: space.machineId, expectedGeneration: space.expectedGeneration };
    const operation = await this.authority.beginOpen({ ...identity, resumeOnMachineRestart: space.resumeOnMachineRestart });
    try {
      onClaimed?.();
      const manifestBytes = await requiredBlob(this.blobs, operation.manifestKey, operation.manifestHash);
      const manifest = parseWorkspaceCheckpoint(JSON.parse(new TextDecoder().decode(manifestBytes)), { projectId: space.projectId, spaceId: space.spaceId, revision: operation.revision });
      await runtime.prepareEmptyRepository();
      await this.gitRemote.fetchCheckpoint({ binding: space.binding, repositoryPath: space.repositoryPath, checkpointRef: manifest.repository.checkpointRef });
      await restoreGitIntermediateCheckpoint({
        repositoryPath: space.repositoryPath,
        branch: manifest.repository.branch,
        checkpoint: manifest.repository,
        lfs: await this.lfs?.read(space.projectId),
      });
      const artifactManifest = await requiredBlob(this.blobs, spaceArtifactManifestKey(space.projectId, space.spaceId, manifest.revision, manifest.artifacts.generation), manifest.artifacts.manifestHash);
      const agent: PortableAgentSnapshot = manifest.agent.kind === 'cloud' ? manifest.agent : {
        kind: 'legacy',
        sessionId: manifest.agent.sessionId,
        ompSessionId: manifest.agent.ompSessionId,
        ompSession: await requiredBlob(this.blobs, spaceOmpCheckpointKey(space.projectId, space.spaceId, manifest.revision), manifest.agent.ompCheckpointHash),
        resumePending: manifest.agent.resumePending,
      };
      await runtime.restoreArtifacts({ generation: manifest.artifacts.generation, manifest: artifactManifest });
      await runtime.restoreAgent(agent);
      await runtime.activate();
      await this.authority.commitOpen({ ...identity, revision: operation.revision });
      return manifest;
    } catch (error) {
      try {
        await this.authority.failOpen({
          ...identity, revision: operation.revision,
          message: error instanceof Error ? error.message : String(error),
        });
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Space restore and rollback failed');
      }
      throw error;
    }
  }
}

async function requiredBlob(store: CheckpointBlobStore, key: string, expectedHash?: string): Promise<Uint8Array> {
  const value = await store.get(key, expectedHash);
  if (!value) throw new WorkspaceDomainError({ domain: 'workspace', code: 'WORKSPACE_CHECKPOINT_MISSING', message: `Checkpoint object ${key} is missing`, context: { key } });
  return value;
}

function hashBytes(bytes: Uint8Array): `sha256:${string}` {
  const hash = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  return `sha256:${hash}`;
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return owned.buffer;
}
