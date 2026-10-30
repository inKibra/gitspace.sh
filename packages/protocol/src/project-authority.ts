import { z } from 'zod';
import { AgentHealthStateSchema, AgentLifecycleStateSchema, SessionActivitySchema } from '@gitspace/protocol-agent';

export const projectLifecycleSchema = z.enum([
  'cloud-only',
  'provisioning',
  'active',
  'archiving',
  'archived',
  'restoring',
  'failed',
  'deleting',
]);
export type ProjectLifecycle = z.infer<typeof projectLifecycleSchema>;

export const workspaceLifecycleSchema = projectLifecycleSchema.exclude(['cloud-only']);
export type WorkspaceLifecycle = z.infer<typeof workspaceLifecycleSchema>;

export const projectOperationStateSchema = z.enum([
  'queued',
  'claimed',
  'running',
  'blocked',
  'failed',
  'succeeded',
  'canceled',
]);
export type ProjectOperationState = z.infer<typeof projectOperationStateSchema>;

export const GITSPACE_SOURCE_PROJECT_ROLE = 'gitspace-source' as const;
/** What a new GitSpace project builds: upstream GitSpace and its `develop`. Project settings can point it elsewhere. */
export const GITSPACE_SOURCE_REPOSITORY = 'https://github.com/inKibra/gitspace.sh.git';
export const GITSPACE_SOURCE_BRANCH = 'develop';

/** How often GitSpace reads a project's origin on its own (Check the origin); `manual` only when someone asks. A
 * repository the account's GitHub App covers also reports each push at once. Daily unless the project chooses. */
export const originCheckIntervalSchema = z.enum(['daily', 'every-6-hours', 'hourly', 'manual']);
export type OriginCheckInterval = z.infer<typeof originCheckIntervalSchema>;
export const ORIGIN_CHECK_INTERVAL_MS: Record<OriginCheckInterval, number | null> = { daily: 86_400_000, 'every-6-hours': 21_600_000, hourly: 3_600_000, manual: null };

/** Compare repository identity, never a project's display name. */
export function isGitSpaceSourceRepository(reference: string | null): boolean {
  return reference !== null && /^(?:(?:https?:\/\/(?:www\.)?github\.com\/)|(?:git@github\.com:)|(?:ssh:\/\/git@github\.com\/))inkibra\/gitspace\.sh(?:\.git)?\/?$/iu.test(reference.trim());
}

/** A new project or workspace identity: a readable label from its name plus a random suffix. */
export function cloudResourceId(name: string): string {
  const label = name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 48) || 'space';
  return `${label}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Canonical address of a remote repository: an HTTPS/SSH root URL, an scp-style SSH address, or GitHub `owner/repo`.
 * Rejects Git options, credentials, and file or branch pages. */
export function normalizeRemoteRepositoryUrl(input: string): string {
  const address = input.trim();
  if (!address || address.startsWith('-') || /[\u0000-\u001f\u007f]/u.test(address)) {
    throw new Error('Enter a repository root HTTPS/SSH URL or GitHub owner/repo, not a Git option.');
  }
  if (/^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+\/?$/iu.test(address)) {
    return normalizeRemoteRepositoryUrl(`https://github.com/${address}`);
  }
  const scp = /^(?:[a-z0-9_.-]+@)?([a-z0-9][a-z0-9.-]*):([^:].*)$/iu.exec(address);
  if (scp && !address.includes('://')) {
    normalizeRemoteRepositoryUrl(`ssh://${address.slice(0, address.indexOf(':'))}/${scp[2]!.replace(/^\/+/u, '')}`);
    return address;
  }
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error('Enter a repository root HTTPS/SSH URL or GitHub owner/repo.');
  }
  if (!['https:', 'http:', 'ssh:'].includes(url.protocol) || !url.hostname || url.hostname.startsWith('-') || /\s/u.test(address)) {
    throw new Error('Use a repository HTTPS/SSH URL or GitHub owner/repo.');
  }
  if (url.password || (url.protocol !== 'ssh:' && url.username)) {
    throw new Error('Do not include credentials in the repository URL. Use the account SSH key instead.');
  }
  if (url.search || url.hash) {
    throw new Error('Use the repository root URL without a query or fragment, not a file or branch page.');
  }
  let path: string;
  try {
    path = decodeURIComponent(url.pathname).replace(/\/+$/u, '');
  } catch {
    throw new Error('The repository URL contains an invalid path.');
  }
  if (!path || /[\u0000-\u001f\u007f]/u.test(path) || /^\/[^/]+\/[^/]+\/(?:-\/)?(?:tree|blob|raw)(?:\/|$)/u.test(path)) {
    throw new Error('Use the repository root URL, not a file or branch page.');
  }
  if (url.hostname === 'github.com' || url.hostname === 'www.github.com') {
    if (!/^\/[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/iu.test(path) || /\/(?:\.|\.\.)(?:\.git)?$/u.test(path)) {
      throw new Error('Use the GitHub repository root URL: https://github.com/owner/repo, not a file or branch page.');
    }
    url.hostname = 'github.com';
    if (url.protocol !== 'ssh:') url.pathname = `${path.replace(/\.git$/u, '')}.git`;
  } else {
    url.pathname = url.pathname.replace(/\/+$/u, '');
  }
  return url.toString();
}

export const gitSpaceSourceProvenanceSchema = z.object({
  release: z.string().min(1).max(160).nullable(),
  branch: z.string().min(1).max(512).nullable(),
  commit: z.string().regex(/^[a-f0-9]{40,64}$/iu).nullable(),
});
export type GitSpaceSourceProvenance = z.infer<typeof gitSpaceSourceProvenanceSchema>;

/** What the origin last reported for one branch. `head` null: the branch does not exist there. `behind`: the origin's
 * head is missing from GitSpace's copy (the project repository's base branch, or a workspace's checkout). */
export const remoteBranchStateSchema = z.object({
  head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u).nullable(),
  checkedAt: z.string().datetime(),
  behind: z.boolean(),
});
export type RemoteBranchState = z.infer<typeof remoteBranchStateSchema>;

export const cloudProjectSummarySchema = z.object({
  id: z.string().min(1).max(160),
  name: z.string().min(1).max(160),
  lifecycle: projectLifecycleSchema,
  repositoryReference: z.string().min(1).max(2_048).nullable(),
  baseBranch: z.string().min(1).max(512),
  role: z.literal(GITSPACE_SOURCE_PROJECT_ROLE).nullable().default(null),
  source: gitSpaceSourceProvenanceSchema.nullable().default(null),
  revision: z.number().int().positive(),
  /** The base branch on the origin; null until first checked. Stored rows from before tracking decode as null. */
  remote: remoteBranchStateSchema.nullable().default(null),
  archivedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
});
export type CloudProjectSummary = z.infer<typeof cloudProjectSummarySchema>;

export const cloudWorkspaceDefinitionSchema = z.object({
  id: z.string().min(1).max(160),
  projectId: z.string().min(1).max(160),
  kind: z.enum(['base', 'worktree']),
  name: z.string().min(1).max(160),
  branch: z.string().min(1).max(512),
  phase: z.enum(['plan', 'code', 'review', 'ship']).nullable(),
  sourceKind: z.enum(['base', 'branch', 'workspace', 'pull-request', 'tag', 'commit']),
  sourceRef: z.string().max(2_048),
  sourceCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u).nullable().default(null),
  lifecycle: workspaceLifecycleSchema,
  goalId: z.string().min(1).max(160).nullable(),
  revision: z.number().int().positive(),
  /** This workspace's branch on the origin; null until first checked. */
  remote: remoteBranchStateSchema.nullable().default(null),
  archivedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type CloudWorkspaceDefinition = z.infer<typeof cloudWorkspaceDefinitionSchema>;

export const projectOperationStepSchema = z.object({
  id: z.string().min(1).max(160),
  label: z.string().min(1).max(512),
  state: projectOperationStateSchema,
  message: z.string().max(4_096).nullable(),
  updatedAt: z.string().datetime(),
});

export const cloudProjectOperationSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().min(1).max(160),
  workspaceId: z.string().min(1).max(160).nullable(),
  kind: z.string().min(1).max(160),
  state: projectOperationStateSchema,
  steps: z.array(projectOperationStepSchema).max(128),
  error: z.string().max(8_192).nullable(),
  revision: z.number().int().positive(),
  createdBy: z.string().min(1).max(160),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type CloudProjectOperation = z.infer<typeof cloudProjectOperationSchema>;

export const canonicalSessionSchema = z.object({
  id: z.string().min(1).max(160),
  workspaceId: z.string().min(1).max(160),
  ompSessionId: z.string().min(1).max(160),
  machineId: z.string().min(1).max(160).nullable(),
  state: AgentLifecycleStateSchema,
  sessionObjectKey: z.string().min(1).max(2_048).nullable(),
  sessionObjectHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u).nullable(),
  sessionFormatVersion: z.string().min(1).max(64).nullable(),
  activity: SessionActivitySchema,
  health: AgentHealthStateSchema,
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type CanonicalSession = z.infer<typeof canonicalSessionSchema>;

export const canonicalArtifactScopeSchema = z.object({
  id: z.string().min(1).max(160),
  workspaceId: z.string().min(1).max(160),
  generation: z.number().int().nonnegative(),
  manifestHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u).nullable(),
  updatedAt: z.string().datetime(),
});
export type CanonicalArtifactScope = z.infer<typeof canonicalArtifactScopeSchema>;

export const canonicalArtifactPromotionSchema = z.object({
  id: z.string().uuid(),
  sourceWorkspaceId: z.string().min(1).max(160),
  sourceGeneration: z.number().int().nonnegative(),
  expectedBaseGeneration: z.number().int().nonnegative(),
  committedBaseGeneration: z.number().int().nonnegative().nullable(),
  paths: z.array(z.string().min(1).max(2_048)),
  state: z.enum(['planned', 'committed', 'conflict']),
  updatedAt: z.string().datetime(),
});
export type CanonicalArtifactPromotion = z.infer<typeof canonicalArtifactPromotionSchema>;

export const hostedServiceSourceSchema = z.enum(['declared', 'process']);
export const hostedServiceRouteSchema = z.object({
  hostname: z.string().min(1).max(253),
  workspaceId: z.string().min(1).max(160),
  /** The machine's local service: a declared service or an ad hoc process, by its local name. */
  serviceName: z.string().min(1).max(160),
  source: hostedServiceSourceSchema,
  machineId: z.string().min(1).max(160),
  ingress: z.string().url(),
  portName: z.string().min(1).max(160),
  port: z.number().int().min(1).max(65_535),
  generation: z.number().int().nonnegative(),
  leaseExpiresAt: z.string().datetime(),
  health: z.enum(['starting', 'healthy', 'unhealthy']),
  updatedAt: z.string().datetime(),
});
export type HostedServiceRoute = z.infer<typeof hostedServiceRouteSchema>;
/** Where a workspace URL sends traffic: one machine's local service and port. The stored decision; a route lease only says the target is up. */
export const hostedServicePointerSchema = z.object({
  hostname: z.string().min(1).max(253),
  workspaceId: z.string().min(1).max(160),
  machineId: z.string().min(1).max(160),
  machineLabel: z.string().min(1).max(160),
  serviceName: z.string().min(1).max(160),
  source: hostedServiceSourceSchema,
  portName: z.string().min(1).max(160),
  setAt: z.string().datetime(),
  /** `start`: the first machine to start the declared service claimed it; `pin`: an explicit pin. */
  setBy: z.enum(['start', 'pin']),
});
export type HostedServicePointer = z.infer<typeof hostedServicePointerSchema>;
/** A lease answer: `route` is null when a workspace URL points elsewhere (or, for an ad hoc process, nowhere). */
export const hostedRouteLeaseSchema = z.object({ route: hostedServiceRouteSchema.nullable(), pointer: hostedServicePointerSchema.nullable() });
export type HostedRouteLease = z.infer<typeof hostedRouteLeaseSchema>;
export const hostedRoutesSchema = z.object({ routes: z.array(hostedServiceRouteSchema), pointers: z.array(hostedServicePointerSchema) });
export type HostedRoutes = z.infer<typeof hostedRoutesSchema>;
/** A workspace URL is `<service>--<workspace>--<account>-srv`; a machine URL adds `--<machine>` after the service. No part holds `--`. */
export function hostedServiceUrlKind(hostname: string): 'workspace' | 'machine' {
  return (hostname.split('.')[0] ?? '').split('--').length === 3 ? 'workspace' : 'machine';
}

export const projectEventSchema = z.object({
  offset: z.number().int().positive(),
  eventId: z.string().min(1).max(256),
  scope: z.enum(['machine', 'project', 'workspace', 'session', 'artifact', 'code']),
  entity: z.string().min(1).max(160),
  entityId: z.string().min(1).max(160),
  revision: z.number().int().nonnegative(),
  operation: z.enum(['created', 'updated', 'removed', 'append', 'invalidate', 'code-version']),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});
export type ProjectEvent = z.infer<typeof projectEventSchema>;
