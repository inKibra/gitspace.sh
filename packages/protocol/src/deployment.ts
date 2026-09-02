import { z } from 'zod';

/**
 * Releases: GitSpace built from a workspace (or from our channel) as three
 * bundles - tenant worker, machine, frontend - stored in the tenant's data
 * bucket and described by one record. "Launch into" points the tenant's
 * `desired` at a release; the platform swaps the worker, machines converge on
 * the machine bundle at idle, and the frontend is served by hash. The
 * platform never interprets a bundle; the tenant never uploads its own script.
 */

const idSchema = z.string().min(1).max(160);
const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

export const releaseTargetSchema = z.enum(['worker', 'machine', 'frontend']);
export type ReleaseTarget = z.infer<typeof releaseTargetSchema>;

export const releaseArtifactSchema = z.object({
  /** Object key in the tenant data bucket; a prefix for the frontend tree. */
  key: z.string().min(1).max(2_048),
  hash: hashSchema,
  /** Bytes for single-file bundles; total for the frontend tree. */
  size: z.number().int().nonnegative(),
});
export type ReleaseArtifact = z.infer<typeof releaseArtifactSchema>;

/** Worker metadata the platform needs to upload the bundle; derived from the workspace's wrangler config. */
export const workerReleaseMetadataSchema = z.object({
  mainModule: z.string().min(1).max(160),
  compatibilityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  compatibilityFlags: z.array(z.string().min(1).max(80)).max(32),
  durableObjects: z.array(z.object({ name: idSchema, className: idSchema })).max(64),
  /** Ordered migration tags; the platform applies only the ones after the tenant's current tag. */
  migrations: z.array(z.object({ tag: idSchema, newSqliteClasses: z.array(idSchema).max(32) })).max(64),
});
export type WorkerReleaseMetadata = z.infer<typeof workerReleaseMetadataSchema>;

export const releaseStatusSchema = z.enum(['pending', 'applied', 'failed', 'skipped']);
export type ReleaseStatus = z.infer<typeof releaseStatusSchema>;

export const releaseRecordSchema = z.object({
  /** Git sha of the workspace build, or `channel:<version>` for our builds. */
  sha: z.string().min(1).max(160),
  label: z.string().min(1).max(160),
  workspaceId: idSchema.nullable(),
  builtBy: idSchema,
  createdAt: z.string().datetime(),
  artifacts: z.object({
    worker: releaseArtifactSchema.nullable(),
    machine: releaseArtifactSchema.nullable(),
    frontend: releaseArtifactSchema.nullable(),
  }),
  worker: workerReleaseMetadataSchema.nullable(),
  status: z.object({
    worker: releaseStatusSchema,
    frontend: releaseStatusSchema,
    machines: z.record(idSchema, releaseStatusSchema),
  }),
  error: z.string().max(4_096).nullable(),
});
export type ReleaseRecord = z.infer<typeof releaseRecordSchema>;

export const stageReleaseInputSchema = releaseRecordSchema.pick({ sha: true, label: true, workspaceId: true, artifacts: true, worker: true });
export type StageReleaseInput = z.infer<typeof stageReleaseInputSchema>;

/** What the tenant wants running: a release sha, or null for our channel build. */
export const tenantDesiredSchema = z.object({
  sha: z.string().min(1).max(160).nullable(),
  targets: z.array(releaseTargetSchema),
  updatedAt: z.string().datetime(),
});
export type TenantDesired = z.infer<typeof tenantDesiredSchema>;

export const deploymentStatusSchema = z.object({
  desired: tenantDesiredSchema,
  current: z.object({
    /** Worker version string as reported by the tenant's own `/healthz`. */
    worker: z.object({ sha: z.string().nullable(), version: z.string().nullable() }),
    machines: z.record(idSchema, z.object({ sha: z.string().nullable(), generation: z.string().nullable() })),
  }),
  releases: z.array(releaseRecordSchema),
});
export type DeploymentStatus = z.infer<typeof deploymentStatusSchema>;

/** Body the tenant sends the platform to swap its own worker. */
export const platformDeployRequestSchema = z.object({
  sha: z.string().min(1).max(160),
  /** Key of the worker bundle in the shared data bucket, under the tenant's prefix. */
  bundleKey: z.string().min(1).max(2_048),
  bundleHash: hashSchema,
  metadata: workerReleaseMetadataSchema,
});
export type PlatformDeployRequest = z.infer<typeof platformDeployRequestSchema>;

export const platformDeployResponseSchema = z.object({
  sha: z.string(),
  healthy: z.boolean(),
  /** Set when the health probe failed and the platform restored the previous script. */
  revertedTo: z.string().nullable(),
  appliedMigrationTag: z.string().nullable(),
});
export type PlatformDeployResponse = z.infer<typeof platformDeployResponseSchema>;

export const platformRevertRequestSchema = z.object({ to: z.enum(['previous', 'channel']) });
export type PlatformRevertRequest = z.infer<typeof platformRevertRequestSchema>;

/** Tenant → platform: the worker's own version stamp, served at `/healthz` and compared after upload. */
export const WORKER_VERSION_HEADER = 'x-gitspace-worker-version';
