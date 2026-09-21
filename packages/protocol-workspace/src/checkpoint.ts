import { z } from 'zod';
import { WorkspaceDomainError } from './errors.js';

export const SPACE_CHECKPOINT_VERSION = 1 as const;
const storageIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/u).refine((value) => value !== '.' && value !== '..');
const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const gitObjectIdSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);

/** Plaintext chunks leave room for encryption below the 64 MiB application-object limit. */
export const CHECKPOINT_CHUNK_BYTES = 32 * 1024 * 1024;
/** Distinguishes an encrypted chunk inventory from a single encrypted artifact. */
export const CHUNKED_CHECKPOINT_VERSION = 2;

export const chunkedCheckpointManifestSchema = z.object({
  version: z.literal(1),
  size: z.number().int().min(CHECKPOINT_CHUNK_BYTES + 1),
  chunks: z.array(z.object({
    hash: hashSchema,
    size: z.number().int().positive().max(CHECKPOINT_CHUNK_BYTES),
  }).strict()).min(2),
}).strict().superRefine((manifest, context) => {
  if (manifest.chunks.length !== Math.ceil(manifest.size / CHECKPOINT_CHUNK_BYTES)
    || manifest.chunks.some((chunk, index) => chunk.size !== Math.min(CHECKPOINT_CHUNK_BYTES, manifest.size - index * CHECKPOINT_CHUNK_BYTES))) {
    context.addIssue({ code: 'custom', message: 'Checkpoint chunks do not cover the declared size with canonical boundaries' });
  }
});

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
  const parsed = storageIdSchema.safeParse(value);
  if (!parsed.success) throw new WorkspaceDomainError({ domain: 'workspace', code: 'WORKSPACE_CHECKPOINT_INVALID', message: 'Checkpoint storage identity must be a single safe path component', context: { value } });
  return parsed.data;
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
  checkpointRevision(revision);
  if (!Number.isSafeInteger(generation) || generation < 0) throw new WorkspaceDomainError({ domain: 'workspace', code: 'WORKSPACE_REVISION_INVALID', message: 'Artifact generation must be a non-negative safe integer', context: { generation } });
  return `${spaceStorageRoot(projectId, spaceId)}/artifacts/manifests/${revision}/${generation}.enc`;
}

export function spaceCheckpointRoot(projectId: string, spaceId: string, revision: number): string {
  checkpointRevision(revision);
  return `${spaceStorageRoot(projectId, spaceId)}/checkpoints/${revision}`;
}

export function spaceCheckpointManifestKey(projectId: string, spaceId: string, revision: number): string {
  return `${spaceCheckpointRoot(projectId, spaceId, revision)}/manifest.enc`;
}

export function spaceOmpCheckpointKey(projectId: string, spaceId: string, revision: number): string {
  checkpointRevision(revision);
  return `${spaceAgentRoot(projectId, spaceId)}/omp/${revision}.enc`;
}


export function spaceHandoffRoot(projectId: string, spaceId: string, handoffId: string): string {
  return `${spaceStorageRoot(projectId, spaceId)}/handoffs/${storageId(handoffId)}`;
}

export function spaceGitCheckpointRef(spaceId: string, revision: number): string {
  checkpointRevision(revision);
  return `refs/gitspace/spaces/${storageId(spaceId)}/checkpoints/${revision}`;
}

export function checkpointRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision <= 0) throw new WorkspaceDomainError({ domain: 'workspace', code: 'WORKSPACE_REVISION_INVALID', message: 'Checkpoint revision must be a positive safe integer', context: { revision } });
}

/** The object bytes are untrusted until both schema and claimed identity agree. */
export function parseWorkspaceCheckpoint(value: unknown, expected?: { projectId: string; spaceId: string; revision: number }): SpaceCheckpointManifest {
  const parsed = spaceCheckpointManifestSchema.safeParse(value);
  if (!parsed.success) throw new WorkspaceDomainError({ domain: 'workspace', code: 'WORKSPACE_CHECKPOINT_INVALID', message: parsed.error.message, context: expected ?? {} });
  const manifest = parsed.data;
  if (expected && (manifest.projectId !== expected.projectId || manifest.spaceId !== expected.spaceId || manifest.revision !== expected.revision)) throw new WorkspaceDomainError({ domain: 'workspace', code: 'WORKSPACE_CHECKPOINT_MISMATCH', message: 'Checkpoint manifest does not match the requested space revision', context: expected });
  if (manifest.previousRevision !== null && manifest.previousRevision >= manifest.revision) throw new WorkspaceDomainError({ domain: 'workspace', code: 'WORKSPACE_REVISION_INVALID', message: 'Checkpoint revision must advance its predecessor', context: { revision: manifest.revision, previousRevision: manifest.previousRevision } });
  if (manifest.repository.checkpointRef !== spaceGitCheckpointRef(manifest.spaceId, manifest.revision)) throw new WorkspaceDomainError({ domain: 'workspace', code: 'WORKSPACE_CHECKPOINT_MISMATCH', message: 'Checkpoint repository reference does not match its space revision', context: { spaceId: manifest.spaceId, revision: manifest.revision } });
  return manifest;
}
