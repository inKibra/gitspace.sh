import { parseWorkspaceCheckpoint, spaceOmpCheckpointKey, WorkspaceDomainError } from '@gitspace/protocol-workspace';
import type { CanonicalSession } from '@gitspace/protocol';
import type { SpaceAuthorityRecord } from '@gitspace/protocol-workspace';
import type { OmpTranscriptEvent } from './omp-runtime.js';
import type { CheckpointBlobStore } from './portable-space-lifecycle.js';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TranscriptPage, TranscriptPageRequest, TranscriptContentPage, TranscriptContentRequest } from '@gitspace/blocks';
import { TranscriptIndex } from './transcript-index.js';

export interface CheckpointTranscriptAuthority {
  getSpace(projectId: string, spaceId: string): Promise<SpaceAuthorityRecord | null>;
  getCanonicalSession(projectId: string, sessionId: string): Promise<CanonicalSession | null>;
}

export interface ClosedSpaceCheckpointMetadata {
  sessionId: string;
  /** Cloud placement generation the checkpoint belongs to. */
  generation: number;
  /** Machine that last published the canonical session; where the space was released from. */
  lastMachineId: string | null;
}

export interface ClosedSpaceTranscript extends ClosedSpaceCheckpointMetadata {
  events: OmpTranscriptEvent[];
}

const CACHE_TTL_MS = 30_000;

interface IndexedCheckpoint {
  projectId: string;
  manifestHash: string;
  at: number;
  metadata: ClosedSpaceCheckpointMetadata;
  ompKey: string;
  ompHash: string;
  indexKey: string;
}

/**
 * Read-only metadata and transcript views of a closed cloud checkpoint.
 * Metadata never downloads or projects the OMP session object.
 */
export class ClosedSpaceTranscriptReader {
  private readonly cache = new Map<string, IndexedCheckpoint>();
  private readonly indexing = new Map<string, Promise<void>>();

  constructor(
    private readonly authority: CheckpointTranscriptAuthority,
    /** The same (encrypting) store the lifecycle writes checkpoints through. */
    private readonly blobs: CheckpointBlobStore,
    private readonly project: (bytes: Uint8Array) => Promise<OmpTranscriptEvent[]>,
    private readonly indexRoot = join(tmpdir(), 'gitspace-transcript-checkpoints'),
  ) {}

  /** Null when the space is not closed in the cloud or has no checkpoint yet. */
  async readMetadata(projectId: string, spaceId: string): Promise<ClosedSpaceCheckpointMetadata | null> {
    const checkpoint = await this.loadMetadata(projectId, spaceId);
    return checkpoint ? { ...checkpoint.metadata } : null;
  }

  async read(projectId: string, spaceId: string): Promise<ClosedSpaceTranscript | null> {
    const checkpoint = await this.loadMetadata(projectId, spaceId);
    if (!checkpoint) return null;
    const index = await this.index(checkpoint);
    try { return { ...checkpoint.metadata, events: index.snapshot() }; }
    finally { index.close(); }
  }

  async page(projectId: string, spaceId: string, request: TranscriptPageRequest): Promise<TranscriptPage | null> {
    const checkpoint = await this.loadMetadata(projectId, spaceId);
    if (!checkpoint) return null;
    const index = await this.index(checkpoint);
    try { return index.page(request); }
    finally { index.close(); }
  }

  async content(projectId: string, spaceId: string, request: TranscriptContentRequest): Promise<TranscriptContentPage | null> {
    const checkpoint = await this.loadMetadata(projectId, spaceId);
    if (!checkpoint) return null;
    const index = await this.index(checkpoint);
    try { return index.content(request); }
    finally { index.close(); }
  }

  private async index(checkpoint: IndexedCheckpoint): Promise<TranscriptIndex> {
    const index = new TranscriptIndex(join(this.indexRoot, `${checkpoint.indexKey}.sqlite`), checkpoint.metadata.sessionId);
    try {
      let pending = this.indexing.get(checkpoint.indexKey);
      if (!pending && !index.initialized) {
        pending = (async () => {
          const bytes = await this.blobs.get(checkpoint.ompKey, checkpoint.ompHash);
          if (!bytes) throw new Error(`Checkpoint object ${checkpoint.ompKey} is missing`);
          index.seed(await this.project(bytes));
        })();
        this.indexing.set(checkpoint.indexKey, pending);
        void pending.finally(() => this.indexing.delete(checkpoint.indexKey)).catch(() => undefined);
      }
      await pending;
      return index;
    } catch (error) {
      index.close();
      throw error;
    }
  }

  private async loadMetadata(projectId: string, spaceId: string): Promise<IndexedCheckpoint | null> {
    const record = await this.authority.getSpace(projectId, spaceId);
    if (!record || record.state !== 'closed' || !record.manifestKey || !record.manifestHash) return null;
    const cached = this.cache.get(spaceId);
    if (cached && cached.projectId === projectId && cached.manifestHash === record.manifestHash && cached.metadata.generation === record.generation && Date.now() - cached.at < CACHE_TTL_MS) {
      cached.metadata.generation = record.generation;
      return cached;
    }
    const manifestBytes = await this.blobs.get(record.manifestKey, record.manifestHash);
    if (!manifestBytes) throw new Error(`Checkpoint manifest ${record.manifestKey} is missing`);
    const manifest = parseWorkspaceCheckpoint(JSON.parse(new TextDecoder().decode(manifestBytes)));
    if (manifest.projectId !== projectId || manifest.spaceId !== spaceId) throw new WorkspaceDomainError({ domain: 'workspace', code: 'WORKSPACE_CHECKPOINT_MISMATCH', message: 'Checkpoint manifest does not belong to this space', context: { projectId, spaceId } });
    const canonical = await this.authority.getCanonicalSession(projectId, manifest.agent.sessionId);
    const checkpoint = {
      projectId,
      manifestHash: record.manifestHash,
      at: Date.now(),
      metadata: {
        sessionId: manifest.agent.sessionId,
        generation: record.generation,
        lastMachineId: canonical?.machineId ?? null,
      },
      ompKey: spaceOmpCheckpointKey(projectId, spaceId, manifest.revision),
      ompHash: manifest.agent.ompCheckpointHash,
      indexKey: createHash('sha256').update(JSON.stringify([projectId, spaceId, record.generation, manifest.agent.sessionId, manifest.agent.ompCheckpointHash])).digest('hex'),
    };
    this.cache.set(spaceId, checkpoint);
    return checkpoint;
  }
}
