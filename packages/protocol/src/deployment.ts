import { z } from 'zod';

/**
 * Releases: GitSpace built from a workspace (or from our channel) as three
 * independently selectable bundles - tenant worker, machine, and account
 * frontend - stored in the tenant's data bucket and described by one
 * record. "Launch into" points the tenant's `desired` at a release; the
 * platform swaps the worker, machines converge on complete host bundles,
 * and the frontend is served by hash. The platform never interprets a bundle;
 * the tenant never uploads its own script.
 */

const idSchema = z.string().min(1).max(160);
const hashSchema = z.templateLiteral(['sha256:', z.string().regex(/^[a-f0-9]{64}$/u)]);

export const tenantIdSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u)
  .refine((name) => name !== 'api' && name !== 'platform' && name !== 'releases', 'Tenant name is reserved for provider routing or the release channel');

export const releaseTargetSchema = z.enum(['worker', 'machine', 'frontend']);
export type ReleaseTarget = z.infer<typeof releaseTargetSchema>;

export const releaseArtifactSchema = z.object({
  /** Object key; the worker and executable targets point to an authenticated manifest, frontend to a tree prefix. */
  key: z.string().min(1).max(2_048),
  hash: hashSchema,
  /** Bytes of the referenced object (the manifest for the worker and executables); total bytes for the frontend tree. */
  size: z.number().int().nonnegative(),
});
export type ReleaseArtifact = z.infer<typeof releaseArtifactSchema>;

const workerModuleNameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/u);
const WORKER_MODULE_MAX_BYTES = 32 * 1024 * 1024;
const WORKER_GRAPH_MAX_BYTES = 48 * 1024 * 1024;

/** A Worker release's inventory: each module is its own object (`workerModuleKey`), pinned here by size and digest. */
export const WORKER_MANIFEST_FILE = 'worker.manifest.json';
export const workerManifestSchema = z.object({
  version: z.literal(2),
  mainModule: workerModuleNameSchema,
  modules: z.array(z.object({
    name: workerModuleNameSchema,
    type: z.enum(['esm', 'wasm']),
    size: z.number().int().nonnegative().max(WORKER_MODULE_MAX_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict()).min(1).max(64),
}).strict().superRefine((manifest, context) => {
  const names = new Set<string>();
  for (const module of manifest.modules) {
    if (names.has(module.name)) context.addIssue({ code: 'custom', message: `Duplicate worker module ${module.name}` });
    names.add(module.name);
  }
  if (manifest.modules.reduce((bytes, module) => bytes + module.size, 0) > WORKER_GRAPH_MAX_BYTES) context.addIssue({ code: 'custom', message: 'Worker module graph exceeds its size limit' });
  if (!manifest.modules.some(module => module.name === manifest.mainModule && module.type === 'esm')) context.addIssue({ code: 'custom', message: 'Worker manifest has no declared main module' });
});
export type WorkerManifest = z.infer<typeof workerManifestSchema>;

/** Modules sit beside their manifest: `<dir>/worker.manifest.json` names `<dir>/worker/<module>`. */
export function workerModuleKey(manifestKey: string, name: string): string {
  return `${manifestKey.slice(0, -WORKER_MANIFEST_FILE.length)}worker/${name}`;
}

/**
 * LEGACY(single-bundle releases): every module base64-encoded in one JSON document. Read only by the platform for
 * deploy requests and stored releases from before module releases; delete with `legacyPlatformDeployRequestSchema`.
 */
export const workerBundleSchema = z.object({
  version: z.literal(1),
  modules: z.array(z.object({
    name: workerModuleNameSchema,
    type: z.enum(['esm', 'wasm']),
    hash: hashSchema,
    bytes: z.number().int().nonnegative().max(WORKER_MODULE_MAX_BYTES),
    base64: z.string().max(44 * 1024 * 1024),
  }).strict()).min(1).max(64),
}).strict();

/** Worker metadata the platform needs to upload the worker; derived from the workspace's wrangler config. */
/** The resource sources this code binds. A release names only these when it is built. */
export const resourceSourceSchema = z.enum(['object-storage', 'object-storage-name', 'artifacts', 'worker-loader', 'browser-rendering', 'workers-ai', 'tenant-id', 'account-id', 'root-public-key', 'provider-token', 'platform-url', 'platform-service', 'application-url', 'transport-url', 'public-assets', 'release-channel', 'literal']);
export type ResourceSource = z.infer<typeof resourceSourceSchema>;

export const workerReleaseMetadataSchema = z.object({
  mainModule: z.string().min(1).max(160),
  compatibilityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  compatibilityFlags: z.array(z.string().min(1).max(80)).max(32),
  durableObjects: z.array(z.object({ name: idSchema, className: idSchema })).max(64),
  resources: z.array(z.object({
    name: idSchema,
    /** A source this code knows (`resourceSourceSchema`) or, in a release built by newer code, one it does not: a
     * deployer skips those rather than refusing the release. */
    source: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u),
    value: z.string().max(4096).optional(),
  })).max(64),
  /** Ordered migration tags; the platform applies only the ones after the tenant's current tag. */
  migrations: z.array(z.object({ tag: idSchema, newSqliteClasses: z.array(idSchema).max(32), deletedClasses: z.array(idSchema).max(32).default([]) })).max(64),
}).superRefine((metadata, context) => {
  const names = new Set<string>();
  for (const binding of [...metadata.durableObjects, ...metadata.resources]) {
    if (names.has(binding.name)) context.addIssue({ code: 'custom', message: `Duplicate provider binding ${binding.name}` });
    names.add(binding.name);
  }
  for (const resource of metadata.resources) {
    if (resource.source === 'literal' && resource.value === undefined) context.addIssue({ code: 'custom', message: `Literal provider binding ${resource.name} requires a value` });
  }
});

/** Reproducibility envelope for the account-owned OMP pin and patch set. */
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

/** Native generations are host-specific, including libc (Linux) or Darwin kernel ABI. */
export const nativeAbiSchema = z.object({
  platform: z.enum(['linux', 'darwin']),
  arch: z.enum(['x64', 'arm64']),
  minimumVersion: z.string().regex(/^\d+\.\d+(?:\.\d+)?$/u),
}).strict();
export type NativeAbi = z.infer<typeof nativeAbiSchema>;

/** Authenticated host-specific payload: complete machine files or an OMP runtime recipe. */
export const executableArtifactManifestSchema = z.object({
  version: z.literal(1),
  target: z.enum(['machine', 'omp']),
  /** Absent on legacy artifacts, which cannot execute profile-managed inference. */
  inferenceVersion: z.literal(1).optional(),
  entrypoint: z.enum(['machine.js', 'omp.js']),
  compatibility: z.object({
    platform: z.enum(['linux', 'darwin', 'win32']),
    arch: z.enum(['x64', 'arm64']),
    bunVersion: z.string().min(1).max(80),
    protocolVersion: z.literal(1),
    /** Older manifests predate native dependency selection. New builders always record this. */
    nativeAbi: nativeAbiSchema.optional(),
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

const commitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
/** A published release: `<commit>:<SHA-256 of that commit's manifest.json>`. The commit locates the manifest in the
 * channel, the hash proves its bytes, and the manifest pins every file. */
export const releasePinSchema = z.string().regex(/^[a-f0-9]{40}:[a-f0-9]{64}$/u);
/** Where a release came from: a workspace checkout at its branch commit plus uncommitted files (unknown for releases
 * recorded before counts were kept), a clean commit of the GitSpace project's repository (no branch for releases
 * recorded before branches were kept), or a release GitHub published to the channel, used by reference. */
export const releaseSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace'), workspaceId: idSchema, commit: commitSchema, uncommittedFiles: z.number().int().nonnegative().nullable() }).strict(),
  z.object({ kind: z.literal('canonical'), repository: z.string().min(1), branch: z.string().min(1).nullable(), commit: commitSchema }).strict(),
  /** `tag` is null for a release published before tags named releases. */
  z.object({ kind: z.literal('release'), tag: z.string().min(1).max(160).nullable(), pin: releasePinSchema }).strict(),
]);
export type ReleaseSource = z.infer<typeof releaseSourceSchema>;
/** What a launch applies: a workspace checkout or a commit of the GitSpace project's repository and branch, built on a
 * machine; or a release the account already holds (Back to default, a published release), applied by the account. */
export const launchSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace'), workspaceId: idSchema }).strict(),
  z.object({ kind: z.literal('canonical'), repository: z.string().min(1), branch: z.string().min(1), commit: commitSchema }).strict(),
  z.object({ kind: z.literal('release'), sha: idSchema }).strict(),
]);
export type LaunchSource = z.infer<typeof launchSourceSchema>;
/** The head of the GitSpace project's base branch, as the account last read it from the project's repository. */
export const canonicalHeadSchema = z.object({ repository: z.string().min(1), branch: z.string().min(1), commit: commitSchema, checkedAt: z.string().datetime() }).strict();
export type CanonicalHead = z.infer<typeof canonicalHeadSchema>;
export const releaseRecordSchema = z.object({
  /** The release key: a commit (canonical or published), or a workspace commit with `-dirty.<fingerprint>` for
   * uncommitted changes. */
  sha: z.string().min(1).max(160),
  label: z.string().min(1).max(160),
  /** Null only for releases recorded before sources were kept whose origin cannot be derived. */
  source: releaseSourceSchema.nullable(),
  builtBy: idSchema,
  createdAt: z.string().datetime(),
  /** Capability of every included target, not inferred from a tenant's current selection. */
  inferenceVersion: z.literal(1).optional(),
  artifacts: z.object({
    worker: releaseArtifactSchema.nullable(),
    machine: releaseArtifactSchema.nullable(),
    /** Read-only history from releases built before the cloud runtime cutover. */
    omp: releaseArtifactSchema.nullable().optional(),
    frontend: releaseArtifactSchema.nullable(),
    /** The portable machine release built with the machine (`portable.manifest.json`, see `machine-release`); absent
     * on releases built before it and from source trees that cannot build one. */
    portable: releaseArtifactSchema.optional(),
  }),
  worker: workerReleaseMetadataSchema.nullable(),
  /** Read-only history; new releases cannot stage an OMP runtime. */
  omp: ompReleaseMetadataSchema.nullable().optional(),
  status: z.object({
    worker: releaseStatusSchema,
    frontend: releaseStatusSchema,
    machines: z.record(idSchema, releaseStatusSchema),
    omps: z.record(idSchema, releaseStatusSchema).optional(),
  }),
  /** Why the release itself failed (staging, the Worker); a machine's failure is its own, in `machineErrors`. */
  error: z.string().max(4_096).nullable(),
  /** Each machine's reason it failed to apply the release, until it applies it. */
  machineErrors: z.record(idSchema, z.string().max(4_096)).optional(),
});
export type ReleaseRecord = z.infer<typeof releaseRecordSchema>;

export const stageReleaseInputSchema = releaseRecordSchema.pick({ sha: true, label: true, source: true, worker: true, inferenceVersion: true }).extend({
  artifacts: releaseRecordSchema.shape.artifacts.omit({ omp: true }).strict(),
}).strict();
export type StageReleaseInput = z.infer<typeof stageReleaseInputSchema>;

/** Independently selected release for each target; null follows the account's default release. */
export const tenantDesiredSchema = z.object({
  worker: idSchema.nullable(),
  machine: idSchema.nullable(),
  frontend: idSchema.nullable(),
  updatedAt: z.string().datetime(),
});
export type TenantDesired = z.infer<typeof tenantDesiredSchema>;

/** Native executor protocol, independent of relay framing and cloud inference. */
export const MACHINE_EXECUTION_PROTOCOL_VERSION = 1;
export const machineNativePlatformSchema = z.enum(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']);
export const machineProtocolInputSchema = z.object({
  version: z.number().int().positive().nullable(),
  blocker: z.string().max(4_096).nullable().optional(),
  platform: machineNativePlatformSchema.nullable().optional(),
});
export const machineExecutionAdmissionSchema = z.object({
  version: z.number().int().positive().nullable(),
  required: z.literal(MACHINE_EXECUTION_PROTOCOL_VERSION),
  state: z.enum(['ready', 'updating', 'blocked']),
  releaseSha: z.string().nullable(),
  error: z.string().nullable(),
});
export type MachineExecutionAdmission = z.infer<typeof machineExecutionAdmissionSchema>;

/** The latest launch, reported phase by phase by the machine that builds it and kept by the account. */
/** A machine process started: any launch it was building and last reported before `startedAt` has no builder now. */
export const launcherStartedInputSchema = z.object({ runningSha: z.string().min(1).max(160).nullable(), startedAt: z.string().datetime() });
export type LauncherStartedInput = z.infer<typeof launcherStartedInputSchema>;

export const launchProgressSchema = z.object({
  launchId: z.string().uuid(),
  source: launchSourceSchema,
  targets: z.array(releaseTargetSchema).min(1),
  sha: z.string().min(1).max(160).nullable(),
  phase: z.string().min(1).max(64),
  message: z.string().max(4_096),
  status: z.enum(['running', 'succeeded', 'failed']),
  error: z.string().max(4_096).nullable(),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type LaunchProgress = z.infer<typeof launchProgressSchema>;

/** A published GitSpace release in the channel's catalog (`CHANNEL_CATALOG` in `release-channel.ts`), newest first. */
export const channelReleaseSchema = z.object({ tag: z.string().min(1).max(160), commit: commitSchema, pin: releasePinSchema, publishedAt: z.string().datetime() }).strict();
export type ChannelRelease = z.infer<typeof channelReleaseSchema>;
export const channelCatalogSchema = z.object({ schemaVersion: z.literal(1), releases: z.array(channelReleaseSchema) }).strict();
export type ChannelCatalog = z.infer<typeof channelCatalogSchema>;

export const deploymentStatusSchema = z.object({
  desired: tenantDesiredSchema,
  /** The release the GitSpace project runs: what a target with no selection, and every new computer, follows. */
  defaultRelease: idSchema.nullable(),
  current: z.object({
    /** Worker version string as reported by the tenant's own `/healthz`. */
    worker: z.object({ sha: z.string().nullable(), version: z.string().nullable() }),
    /** Platform deployment record, included only when it differs from the answering Worker. */
    platformWorker: z.object({ sha: z.string().nullable(), version: z.string().nullable() }).optional(),
    /** Last acknowledgements for machines still in the fleet, including offline members; release results retain removed-machine history. */
    machines: z.record(idSchema, z.object({ sha: z.string().nullable(), generation: z.string().nullable() })),
  }),
  releases: z.array(releaseRecordSchema),
  machineExecution: z.record(idSchema, machineExecutionAdmissionSchema).optional(),
  launch: launchProgressSchema.nullable(),
  canonical: canonicalHeadSchema.nullable(),
});
export type DeploymentStatus = z.infer<typeof deploymentStatusSchema>;

/** Body the tenant sends the platform to swap its own worker. */
export const platformDeployRequestSchema = z.object({
  sha: z.string().min(1).max(160),
  /** Key of the release's worker manifest in the shared data bucket, under the tenant's prefix; its modules sit beside it. */
  manifestKey: z.string().min(1).max(2_048).refine(key => key.endsWith(`/${WORKER_MANIFEST_FILE}`), 'Worker release has no module manifest; rebuild it'),
  /** Digest of the manifest bytes; the manifest pins every module. */
  manifestHash: hashSchema,
  metadata: workerReleaseMetadataSchema,
});
export type PlatformDeployRequest = z.infer<typeof platformDeployRequestSchema>;

/**
 * LEGACY(single-bundle releases): the body a tenant running a release from before module releases sends. Its key names
 * a single bundle, or a module manifest when a newer machine built the release. Delete once every tenant sends `manifestKey`.
 */
export const legacyPlatformDeployRequestSchema = z.object({
  sha: z.string().min(1).max(160),
  bundleKey: z.string().min(1).max(2_048),
  bundleHash: hashSchema,
  metadata: workerReleaseMetadataSchema,
});
export type LegacyPlatformDeployRequest = z.infer<typeof legacyPlatformDeployRequestSchema>;

export const platformDeployResponseSchema = z.object({
  sha: z.string(),
  healthy: z.boolean(),
  /** Set when the health probe failed and the platform restored the previous script. */
  revertedTo: z.string().nullable(),
  appliedMigrationTag: z.string().nullable(),
});
export type PlatformDeployResponse = z.infer<typeof platformDeployResponseSchema>;

export const platformRevertRequestSchema = z.object({
  to: z.literal('previous'),
  /** Names the swap: the platform keeps its outcome under this id, at `GET /__platform/tenants/<tenant>/operations/<id>`,
  * for a caller that did not get the answer. The same id never starts a second swap. */
  operationId: z.string().uuid().optional(),
});
export type PlatformRevertRequest = z.infer<typeof platformRevertRequestSchema>;

/** Tenant → platform: the worker's own version stamp, served at `/healthz` and compared after upload. */
export const WORKER_VERSION_HEADER = 'x-gitspace-worker-version';
