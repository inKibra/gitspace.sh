import { z } from 'zod';

export const SPACE_CHECKPOINT_VERSION = 1 as const;
const storageIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/u);
const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const gitObjectIdSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);

export const spaceCheckpointManifestSchema = z.object({
  version: z.literal(SPACE_CHECKPOINT_VERSION),
  projectId: storageIdSchema,
  spaceId: storageIdSchema,
  revision: z.number().int().positive(),
  previousRevision: z.number().int().positive().nullable(),
  repository: z.object({
    checkpointRef: z.string().min(1).max(512),
    headCommit: gitObjectIdSchema,
    branch: z.string().min(1).max(255),
    indexCommit: gitObjectIdSchema,
    worktreeCommit: gitObjectIdSchema,
  }),
  agent: z.object({
    sessionId: storageIdSchema,
    ompSessionId: storageIdSchema,
    ompCheckpointHash: hashSchema,
    resumePending: z.boolean().default(false),
  }),
  artifacts: z.object({
    manifestHash: hashSchema,
    generation: z.number().int().nonnegative(),
  }),
  createdAt: z.iso.datetime(),
});

export type SpaceCheckpointManifest = z.infer<typeof spaceCheckpointManifestSchema>;

function storageId(value: string): string {
  return storageIdSchema.parse(value);
}

export function projectStorageRoot(projectId: string): string {
  return `projects/${storageId(projectId)}`;
}

export function projectRepositoryPrefix(projectId: string): string {
  return `${projectStorageRoot(projectId)}/repo`;
}

export function projectArtifactBlobKey(projectId: string, hash: `sha256:${string}`): string {
  hashSchema.parse(hash);
  return `${projectStorageRoot(projectId)}/artifact-blobs/${hash.slice('sha256:'.length)}`;
}

export function spaceStorageRoot(projectId: string, spaceId: string): string {
  return `${projectStorageRoot(projectId)}/spaces/${storageId(spaceId)}`;
}

export function spaceAgentRoot(projectId: string, spaceId: string): string {
  return `${spaceStorageRoot(projectId, spaceId)}/agent`;
}

export function spaceArtifactManifestKey(projectId: string, spaceId: string, revision: number, generation: number): string {
  if (!Number.isSafeInteger(revision) || revision <= 0) throw new RangeError('Checkpoint revision must be a positive safe integer');
  if (!Number.isSafeInteger(generation) || generation < 0) throw new RangeError('Artifact generation must be a non-negative safe integer');
  return `${spaceStorageRoot(projectId, spaceId)}/artifacts/manifests/${revision}/${generation}.enc`;
}

export function spaceCheckpointRoot(projectId: string, spaceId: string, revision: number): string {
  if (!Number.isSafeInteger(revision) || revision <= 0) throw new RangeError('Checkpoint revision must be a positive safe integer');
  return `${spaceStorageRoot(projectId, spaceId)}/checkpoints/${revision}`;
}

export function spaceCheckpointManifestKey(projectId: string, spaceId: string, revision: number): string {
  return `${spaceCheckpointRoot(projectId, spaceId, revision)}/manifest.enc`;
}

export function spaceOmpCheckpointKey(projectId: string, spaceId: string, revision: number): string {
  return `${spaceAgentRoot(projectId, spaceId)}/omp/${revision}.enc`;
}


export function spaceHandoffRoot(projectId: string, spaceId: string, handoffId: string): string {
  return `${spaceStorageRoot(projectId, spaceId)}/handoffs/${storageId(handoffId)}`;
}

export function spaceGitCheckpointRef(spaceId: string, revision: number): string {
  if (!Number.isSafeInteger(revision) || revision <= 0) throw new RangeError('Checkpoint revision must be a positive safe integer');
  return `refs/gitspace/spaces/${storageId(spaceId)}/checkpoints/${revision}`;
}
