import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import {
  CHECKPOINT_CHUNK_BYTES,
  CHUNKED_CHECKPOINT_VERSION,
  chunkedCheckpointManifestSchema,
  spaceArtifactManifestKey,
  spaceCheckpointManifestKey,
  parseWorkspaceCheckpoint,
  spaceOmpCheckpointKey,
  type SpaceCheckpointManifest,
  WorkspaceDomainError,
} from '@gitspace/protocol-workspace';
import { decryptArtifactBytes, encryptArtifactBytes } from '@gitspace/protocol';
import { createGitIntermediateCheckpoint, restoreGitIntermediateCheckpoint } from './git-checkpoint.js';
import type { WalgitProjectBinding } from './walgit-supervisor.js';

export interface CheckpointBlobStore {
  put(key: string, bytes: Uint8Array): Promise<`sha256:${string}`>;
  get(key: string, expectedHash?: string): Promise<Uint8Array | null>;
}


export class FileCheckpointBlobStore implements CheckpointBlobStore {
  constructor(private readonly root: string) {}

  async put(key: string, bytes: Uint8Array): Promise<`sha256:${string}`> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return hashBytes(bytes);
  }

  async get(key: string, expectedHash?: string): Promise<Uint8Array | null> {
    try {
      const bytes = new Uint8Array(await readFile(this.path(key)));
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
    if (bytes.byteLength <= CHECKPOINT_CHUNK_BYTES) {
      return this.inner.put(key, await encryptArtifactBytes(bytes, this.key));
    }
    const chunks: Array<{ hash: `sha256:${string}`; size: number }> = [];
    for (let offset = 0; offset < bytes.byteLength; offset += CHECKPOINT_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, offset + CHECKPOINT_CHUNK_BYTES);
      const sealed = await encryptArtifactBytes(chunk, this.key);
      const hash = hashBytes(sealed);
      const storedHash = await this.inner.put(`${key}.chunks/${hash.slice(7)}`, sealed);
      if (storedHash !== hash) throw new Error(`Checkpoint chunk for ${key} failed upload integrity verification`);
      chunks.push({ hash, size: chunk.byteLength });
    }
    const inventory = new TextEncoder().encode(JSON.stringify({ version: 1, size: bytes.byteLength, chunks }));
    const sealed = await encryptArtifactBytes(inventory, this.key);
    const envelope = new Uint8Array(1 + sealed.byteLength);
    envelope[0] = CHUNKED_CHECKPOINT_VERSION;
    envelope.set(sealed, 1);
    // Publish last: the authenticated inventory must never reference an incomplete upload.
    return this.inner.put(key, envelope);
  }

  async get(key: string, expectedHash?: string): Promise<Uint8Array | null> {
    const sealed = await this.inner.get(key, expectedHash);
    if (!sealed) return null;
    if (sealed[0] !== CHUNKED_CHECKPOINT_VERSION) return decryptArtifactBytes(sealed, this.key);
    const inventory = await decryptArtifactBytes(sealed.subarray(1), this.key);
    const manifest = chunkedCheckpointManifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(inventory)));
    const bytes = new Uint8Array(manifest.size);
    let offset = 0;
    for (const chunk of manifest.chunks) {
      const chunkKey = `${key}.chunks/${chunk.hash.slice(7)}`;
      const stored = await requiredBlob(this.inner, chunkKey, chunk.hash);
      const plaintext = await decryptArtifactBytes(stored, this.key);
      if (plaintext.byteLength !== chunk.size) throw new Error(`Checkpoint chunk ${chunkKey} has an unexpected size`);
      bytes.set(plaintext, offset);
      offset += plaintext.byteLength;
    }
    return bytes;
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
  publishCheckpoint(input: { binding: WalgitProjectBinding; repositoryPath: string; checkpointRef: string }): Promise<void>;
  fetchCheckpoint(input: { binding: WalgitProjectBinding; repositoryPath: string; checkpointRef: string }): Promise<void>;
}

export interface PortableSpaceRuntime {
  quiesce(): Promise<void>;
  resumeAfterFailedClose(): Promise<void>;
  captureAgent(): Promise<{
    sessionId: string;
    ompSessionId: string;
    ompSession: Uint8Array;
    resumePending?: boolean;
  }>;
  captureArtifacts(): Promise<{ generation: number; manifest: Uint8Array }>;
  deleteLocalState(): Promise<void>;
  prepareEmptyRepository(): Promise<void>;
  restoreAgent(input: { sessionId: string; ompSessionId: string; ompSession: Uint8Array; resumePending?: boolean }): Promise<void>;
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
  binding: WalgitProjectBinding;
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
  ) {}

  /** Checkpoint, hand the space back to the cloud, and delete the local copy. */
  async close(space: PortableSpaceDescriptor, runtime: PortableSpaceRuntime): Promise<CloseSpaceResult> {
    const manifest = await this.release(space, runtime, false);
    const warnings: string[] = [];
    try {
      await runtime.deleteLocalState();
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
    return { manifest, warnings };
  }

  /** Checkpoint and hand the space back to the cloud while keeping every local file, so this machine can reclaim it without a restore. */
  async release(space: PortableSpaceDescriptor, runtime: PortableSpaceRuntime, resumeOnMachineRestart = true): Promise<SpaceCheckpointManifest> {
    const identity = { projectId: space.projectId, spaceId: space.spaceId, machineId: space.machineId, expectedGeneration: space.expectedGeneration };
    const operation = await this.authority.beginClose(identity);
    let quiesced = false;
    try {
      quiesced = true;
      await runtime.quiesce();
      const repository = await createGitIntermediateCheckpoint({
        repositoryPath: space.repositoryPath,
        spaceId: space.spaceId,
        revision: operation.revision,
        portableUntrackedPaths: space.portableUntrackedPaths,
      });
      await this.gitRemote.publishCheckpoint({ binding: space.binding, repositoryPath: space.repositoryPath, checkpointRef: repository.checkpointRef });
      const [agent, artifacts] = await Promise.all([runtime.captureAgent(), runtime.captureArtifacts()]);
      const ompCheckpointHash = await this.blobs.put(
        spaceOmpCheckpointKey(space.projectId, space.spaceId, operation.revision),
        agent.ompSession,
      );
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
        },
        agent: {
          sessionId: agent.sessionId,
          ompSessionId: agent.ompSessionId,
          ompCheckpointHash,
          resumePending: agent.resumePending ?? false,
        },
        artifacts: { manifestHash: artifactManifestHash, generation: artifacts.generation },
        createdAt: new Date().toISOString(),
      });
      const manifestKey = spaceCheckpointManifestKey(space.projectId, space.spaceId, operation.revision);
      const manifestHash = await this.blobs.put(manifestKey, new TextEncoder().encode(JSON.stringify(manifest)));
      await this.authority.commitClosed({
        ...identity,
        revision: operation.revision,
        manifestKey,
        manifestHash,
        resumeOnMachineRestart,
      });
      return manifest;
    } catch (error) {
      const failures: unknown[] = [error];
      try { await this.authority.abortClose({ ...identity, revision: operation.revision, message: error instanceof Error ? error.message : String(error) }); }
      catch (abortError) { failures.push(abortError); }
      if (quiesced) {
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
      });
      const [ompSession, artifactManifest] = await Promise.all([
        requiredBlob(this.blobs, spaceOmpCheckpointKey(space.projectId, space.spaceId, manifest.revision), manifest.agent.ompCheckpointHash),
        requiredBlob(
          this.blobs,
          spaceArtifactManifestKey(space.projectId, space.spaceId, manifest.revision, manifest.artifacts.generation),
          manifest.artifacts.manifestHash,
        ),
      ]);
      await runtime.restoreArtifacts({ generation: manifest.artifacts.generation, manifest: artifactManifest });
      await runtime.restoreAgent({
        sessionId: manifest.agent.sessionId,
        ompSessionId: manifest.agent.ompSessionId,
        ompSession,
        resumePending: manifest.agent.resumePending,
      });
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
