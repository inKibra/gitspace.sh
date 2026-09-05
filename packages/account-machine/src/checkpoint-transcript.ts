import { spaceCheckpointManifestSchema, spaceOmpCheckpointKey, type CanonicalSession } from '@gitspace/protocol';
import type { CloudSpaceRecord } from './cloud-space-authority.js';
import type { OmpTranscriptEvent } from './omp-runtime.js';
import type { CheckpointBlobStore } from './portable-space-lifecycle.js';

export interface CheckpointTranscriptAuthority {
  getSpace(projectId: string, spaceId: string): Promise<CloudSpaceRecord | null>;
  getCanonicalSession(projectId: string, sessionId: string): Promise<CanonicalSession | null>;
}

export interface ClosedSpaceTranscript {
  sessionId: string;
  /** Cloud placement generation the checkpoint belongs to. */
  generation: number;
  /** Machine that last published the canonical session; where the space was released from. */
  lastMachineId: string | null;
  events: OmpTranscriptEvent[];
}

const CACHE_TTL_MS = 30_000;

/**
 * Read-only view of a closed space's agent transcript straight from its cloud
 * checkpoint, without opening the space anywhere. Keyed by the manifest hash so
 * a re-read within the TTL costs one `space.get`.
 */
export class ClosedSpaceTranscriptReader {
  private readonly cache = new Map<string, { manifestHash: string; at: number; value: ClosedSpaceTranscript }>();

  constructor(
    private readonly authority: CheckpointTranscriptAuthority,
    /** The same (encrypting) store the lifecycle writes checkpoints through. */
    private readonly blobs: CheckpointBlobStore,
    private readonly project: (bytes: Uint8Array) => Promise<OmpTranscriptEvent[]>,
  ) {}

  /** Null when the space is not closed in the cloud or has no checkpoint yet. */
  async read(projectId: string, spaceId: string): Promise<ClosedSpaceTranscript | null> {
    const record = await this.authority.getSpace(projectId, spaceId);
    if (!record || record.state !== 'closed' || !record.manifestKey || !record.manifestHash) return null;
    const cached = this.cache.get(spaceId);
    if (cached && cached.manifestHash === record.manifestHash && Date.now() - cached.at < CACHE_TTL_MS) {
      return { ...cached.value, generation: record.generation };
    }
    const manifestBytes = await this.blobs.get(record.manifestKey, record.manifestHash);
    if (!manifestBytes) throw new Error(`Checkpoint manifest ${record.manifestKey} is missing`);
    const manifest = spaceCheckpointManifestSchema.parse(JSON.parse(new TextDecoder().decode(manifestBytes)));
    const ompKey = spaceOmpCheckpointKey(projectId, spaceId, manifest.revision);
    const [ompSession, canonical] = await Promise.all([
      this.blobs.get(ompKey, manifest.agent.ompCheckpointHash),
      this.authority.getCanonicalSession(projectId, manifest.agent.sessionId),
    ]);
    if (!ompSession) throw new Error(`Checkpoint object ${ompKey} is missing`);
    const value: ClosedSpaceTranscript = {
      sessionId: manifest.agent.sessionId,
      generation: record.generation,
      lastMachineId: canonical?.machineId ?? null,
      events: await this.project(ompSession),
    };
    this.cache.set(spaceId, { manifestHash: record.manifestHash, at: Date.now(), value });
    return value;
  }
}
