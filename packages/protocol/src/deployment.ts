import { z } from 'zod';

/**
 * Releases: GitSpace built from a workspace (or from our channel) as four
 * independently selectable bundles - tenant worker, machine, OMP runtime, and
 * account frontend - stored in the tenant's data bucket and described by one
 * record. "Launch into" points the tenant's `desired` at a release; the
 * platform swaps the worker, machines converge on machine/OMP bundles at idle,
 * and the frontend is served by hash. The platform never interprets a bundle;
 * the tenant never uploads its own script.
 */

const idSchema = z.string().min(1).max(160);
const hashSchema = z.templateLiteral(['sha256:', z.string().regex(/^[a-f0-9]{64}$/u)]);

export const releaseTargetSchema = z.enum(['worker', 'machine', 'omp', 'frontend']);
export type ReleaseTarget = z.infer<typeof releaseTargetSchema>;

export const releaseArtifactSchema = z.object({
  /** Object key; executable targets point to an authenticated manifest, frontend to a tree prefix. */
  key: z.string().min(1).max(2_048),
  hash: hashSchema,
  /** Bytes of the referenced object (manifest for executables); total bytes for the frontend tree. */
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

/** Reproducibility envelope for the account-owned, hermetic OMP runtime bundle. */
export const ompReleaseMetadataSchema = z.object({
  upstreamVersion: z.string().min(1).max(80),
  bunVersion: z.string().min(1).max(80),
  packages: z.record(z.string(), z.string().min(1).max(160)),
  patches: z.array(z.object({ path: z.string().min(1).max(512), hash: hashSchema })).max(64),
});
export type OmpReleaseMetadata = z.infer<typeof ompReleaseMetadataSchema>;

const executableFilePathSchema = z.string().min(1).max(2_048).refine(
  (path) => !/[\\:\0]/u.test(path) && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
  'Executable artifact paths must be relative POSIX paths without traversal',
);

/** Fits below the 64 MiB signed application-object limit, including transport overhead. */
export const EXECUTABLE_CHUNK_BYTES = 32 * 1024 * 1024;

/** Authenticated inventory of a complete host-specific executable generation. */
export const executableArtifactManifestSchema = z.object({
  version: z.literal(1),
  target: z.enum(['machine', 'omp']),
  entrypoint: z.enum(['machine.js', 'omp.js']),
  compatibility: z.object({
    platform: z.enum(['linux', 'darwin', 'win32']),
    arch: z.enum(['x64', 'arm64']),
    bunVersion: z.string().min(1).max(80),
    protocolVersion: z.literal(1),
  }),
  treeHash: hashSchema,
  files: z.array(z.object({
    path: executableFilePathSchema,
    hash: hashSchema,
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    mode: z.union([z.literal(0o644), z.literal(0o755)]),
    chunks: z.array(z.object({
      key: z.string().regex(/^objects\/sha256\/[a-f0-9]{64}$/u),
      hash: hashSchema,
      size: z.number().int().nonnegative().max(EXECUTABLE_CHUNK_BYTES),
    })).min(1),
  })).min(1),
  omp: ompReleaseMetadataSchema.nullable(),
}).superRefine((manifest, context) => {
  const paths = new Set<string>();
  for (const file of manifest.files) {
    if (paths.has(file.path)) context.addIssue({ code: 'custom', message: `Duplicate executable file ${file.path}` });
    paths.add(file.path);
    if (file.chunks.reduce((size, chunk) => size + chunk.size, 0) !== file.size) {
      context.addIssue({ code: 'custom', message: `File ${file.path} chunk sizes differ from file size` });
    }
    if (file.chunks.length !== Math.max(1, Math.ceil(file.size / EXECUTABLE_CHUNK_BYTES))
      || file.chunks.some((chunk, index) => chunk.size !== Math.min(EXECUTABLE_CHUNK_BYTES, file.size - index * EXECUTABLE_CHUNK_BYTES))) {
      context.addIssue({ code: 'custom', message: `File ${file.path} has noncanonical chunk boundaries` });
    }
    for (const chunk of file.chunks) {
      if (chunk.key !== `objects/sha256/${chunk.hash.slice(7)}`) {
        context.addIssue({ code: 'custom', message: `File ${file.path} has a non-content-addressed chunk key` });
      }
    }
  }
  if (manifest.entrypoint !== `${manifest.target}.js` || !paths.has(manifest.entrypoint)) {
    context.addIssue({ code: 'custom', message: 'Executable manifest must contain its target entrypoint' });
  }
  if (manifest.target === 'omp' ? manifest.omp === null : manifest.omp !== null) {
    context.addIssue({ code: 'custom', message: 'Only OMP executable manifests contain OMP metadata' });
  }
  if (manifest.omp && manifest.omp.bunVersion !== manifest.compatibility.bunVersion) {
    context.addIssue({ code: 'custom', message: 'OMP metadata and executable Bun versions differ' });
  }
});
export type ExecutableArtifactManifest = z.infer<typeof executableArtifactManifestSchema>;
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
    omp: releaseArtifactSchema.nullable(),
    frontend: releaseArtifactSchema.nullable(),
  }),
  worker: workerReleaseMetadataSchema.nullable(),
  omp: ompReleaseMetadataSchema.nullable(),
  status: z.object({
    worker: releaseStatusSchema,
    frontend: releaseStatusSchema,
    machines: z.record(idSchema, releaseStatusSchema),
    omps: z.record(idSchema, releaseStatusSchema),
  }),
  error: z.string().max(4_096).nullable(),
});
export type ReleaseRecord = z.infer<typeof releaseRecordSchema>;

export const stageReleaseInputSchema = releaseRecordSchema.pick({ sha: true, label: true, workspaceId: true, artifacts: true, worker: true, omp: true });
export type StageReleaseInput = z.infer<typeof stageReleaseInputSchema>;

/** Independently selected release for each target; null follows that target's channel build. */
export const tenantDesiredSchema = z.object({
  worker: idSchema.nullable(),
  machine: idSchema.nullable(),
  omp: idSchema.nullable(),
  frontend: idSchema.nullable(),
  updatedAt: z.string().datetime(),
});
export type TenantDesired = z.infer<typeof tenantDesiredSchema>;

export const deploymentStatusSchema = z.object({
  desired: tenantDesiredSchema,
  current: z.object({
    /** Worker version string as reported by the tenant's own `/healthz`. */
    worker: z.object({ sha: z.string().nullable(), version: z.string().nullable() }),
    machines: z.record(idSchema, z.object({ sha: z.string().nullable(), ompSha: z.string().nullable(), generation: z.string().nullable() })),
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
