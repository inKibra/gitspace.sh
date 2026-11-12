import { z } from 'zod';
import type { CloudProjectOperation, CloudProjectSummary, CloudWorkspaceDefinition } from '@gitspace/protocol';
import { cloudResourceId, GITSPACE_SOURCE_PROJECT_ROLE } from '@gitspace/protocol';
import type { RuntimeWorkspaceMutationArgumentsSchema } from '@gitspace/protocol/inspector-contract';
import type { RuntimeGitCheckpoint, RuntimeSnapshot } from '@gitspace/protocol-runtime';
import { assertWorkspacePhase, WorkspacePhaseSchema, type WorkspacePhase } from '@gitspace/protocol-workspace';
import { ArtifactsCodeStore, GitDiscoveryError, artifactsProjectRepository, artifactsWorkspaceRepository, isSupportedBranchName } from '@gitspace/runtime-workspace-do';
import { ensureProjectCodeRepository } from './account-runtime-host.js';
import { forwardPosition, type ForwardPosition } from './cloud-stack-status.js';
import { noticeStackChanges } from './stack-notices.js';
import { originAccess, originReadCredentials } from './origin-access.js';
import type { ProjectAuthorityDO } from './project-authority.js';
import { refreshProjectRemote } from './project-remote.js';
import type { SpaceAuthorityDO } from './space-authority.js';
import { forgetTenantScope } from './tenant-store.js';

type ProjectAuthority = DurableObjectStub<ProjectAuthorityDO>;
type SpaceAuthority = DurableObjectStub<SpaceAuthorityDO>;
type RuntimeIdentity = Pick<RuntimeSnapshot, 'projectId' | 'workspaceId'>;

/** Creation steps in order, run in the background after the request records the definition; every step is
 * idempotent, so a retry repeats them all and resumes where the last attempt failed. */
const WORKSPACE_CREATE_STEPS = [
  { id: 'source', label: 'Resolve source' },
  { id: 'repository', label: 'Create workspace repository' },
  { id: 'branch', label: 'Create workspace branch' },
  { id: 'activate', label: 'Activate workspace' },
];

/** The project or workspace a lifecycle call names does not exist in this account. */
export class CloudLifecycleTargetMissing extends Error {
  constructor(readonly target: 'project' | 'workspace', readonly id: string) {
    super(`${target === 'project' ? 'Project' : 'Workspace'} ${id} does not exist`);
  }
}

export interface CloudWorkspaceRequest {
  projectId: string;
  /** The new workspace's id, chosen ahead so a creation retried after a lost reply finds it; otherwise from its name. */
  id?: string;
  name: string;
  branch: string;
  phase?: WorkspacePhase;
  sourceKind: CloudWorkspaceDefinition['sourceKind'];
  sourceRef: string;
  /** Extra dependencies; a `workspace` source is always also a dependency and becomes `stackedOn`. */
  dependsOn?: readonly string[];
}

interface ResolvedSource {
  sourceRef: string;
  /** Null only for a genuinely empty imported repository: the workspace starts unborn on its branch. */
  sourceCommit: string | null;
  /** The repository the workspace forks; it holds `sourceCommit`. */
  repository: string;
  /** A source workspace's whole checkpoint, uncommitted edits included; the new workspace starts from it. */
  checkpoint: RuntimeGitCheckpoint | null;
}

/** A dependency without a phase (one written before phases existed) is at the first phase. */
function phaseCarriers(dependencies: readonly CloudWorkspaceDefinition[]) {
  return dependencies.map(dependency => ({ id: dependency.id, name: dependency.name, phase: dependency.phase ?? 'plan' }));
}

const failureMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

/** The definition fields a creation write carries, with a change applied over its current revision. */
function revise(definition: CloudWorkspaceDefinition, change: Partial<Pick<CloudWorkspaceDefinition, 'lifecycle' | 'sourceRef' | 'sourceCommit'>>) {
  const { revision, archivedAt: _archivedAt, createdAt: _createdAt, updatedAt: _updatedAt, ...fields } = definition;
  return { ...fields, ...change, expectedRevision: revision };
}

async function requireProject(env: Env, userId: string, projectId: string): Promise<ProjectAuthority> {
  if (!(await env.USER_PROJECTS.getByName(userId).list()).some(project => project.id === projectId)) throw new CloudLifecycleTargetMissing('project', projectId);
  return env.PROJECT_AUTHORITY.getByName(`${userId}:${projectId}`);
}

async function requireWorktree(env: Env, userId: string, workspaceId: string): Promise<{ authority: ProjectAuthority; definition: CloudWorkspaceDefinition }> {
  const projectId = await env.USER_PROJECTS.getByName(userId).locateWorkspace(workspaceId);
  if (!projectId) throw new CloudLifecycleTargetMissing('workspace', workspaceId);
  const authority = env.PROJECT_AUTHORITY.getByName(`${userId}:${projectId}`);
  const definition = await authority.getWorkspace(workspaceId);
  if (!definition) throw new CloudLifecycleTargetMissing('workspace', workspaceId);
  if (definition.kind === 'base') throw new Error('The project base workspace is archived, restored and deleted only with its project');
  return { authority, definition };
}

async function requireActiveProject(authority: ProjectAuthority, projectId: string): Promise<CloudProjectSummary> {
  const project = await authority.getProject();
  // The built-in GitSpace project stays cloud-only until a machine materializes it; its workspaces live in the cloud regardless.
  if (!project || (project.lifecycle !== 'active' && project.lifecycle !== 'cloud-only')) throw new Error(`Project ${projectId} is not active`);
  return project;
}

/** Records an operation's steps in order on the project authority; a failure stays on the step that raised it. */
function operationProgress(authority: ProjectAuthority, created: CloudProjectOperation) {
  let operation = created;
  let completed = 0;
  const write = async (failure: string | null) => {
    const now = new Date().toISOString();
    operation = await authority.updateOperation({
      id: operation.id, error: failure,
      state: failure !== null ? 'failed' : completed >= operation.steps.length ? 'succeeded' : 'running',
      steps: operation.steps.map((step, index) => ({
        ...step, updatedAt: now, message: index === completed ? failure : null,
        state: index < completed ? 'succeeded' : index > completed ? 'queued' : failure === null ? 'running' : 'failed',
      })),
    });
    return operation;
  };
  return {
    start(from: number) { completed = from; return write(null); },
    advance() { completed += 1; return write(null); },
    async fail(error: unknown) {
      // The caller rethrows the original failure; an unrecorded failure must not replace it.
      await write(failureMessage(error)).catch((recording: unknown) => console.error('Operation failure was not recorded', { operationId: operation.id, error: recording }));
    },
  };
}

/** The lifecycle changes that run in the background: a request checks and records one (`queueOperation`), and the
 * project's alarm runs it (`runQueuedOperation`). */
const OperationKindSchema = z.enum(['workspace.create', 'workspace.archive', 'workspace.restore', 'workspace.delete', 'project.archive', 'project.restore', 'project.setBaseBranch', 'project.updateBase', 'project.delete', 'project.import']);
type OperationKind = z.infer<typeof OperationKindSchema>;
const labelled = (labels: readonly string[]) => labels.map((label, index) => ({ id: `step-${index + 1}`, label }));

/** Records a lifecycle change a request checked, to run in the background; the request returns with it queued. One
 * project change runs at a time, as does one change per workspace: a second could act on what the first changes. */
async function queueOperation(authority: ProjectAuthority, input: { projectId: string; workspaceId: string | null; kind: OperationKind; steps: ReadonlyArray<{ id: string; label: string }>; summary: string | null; request?: Record<string, unknown> }): Promise<CloudProjectOperation> {
  const running = (await authority.visibleOperations()).find(operation => operation.workspaceId === input.workspaceId && (operation.state === 'queued' || operation.state === 'running'));
  if (running) throw new Error(`Another ${input.workspaceId === null ? 'change to this project' : 'change to this workspace'} is still running (${running.kind}); wait for it to finish`);
  return authority.queueOperation({ ...input, steps: [...input.steps], request: input.request ?? {}, createdBy: 'account' });
}

interface QueuedRun {
  env: Env;
  userId: string;
  authority: ProjectAuthority;
  operation: CloudProjectOperation;
  request: unknown;
  /** Records the current step done and starts the next; the runner records the last one. */
  advance(): Promise<unknown>;
}

/** Runs one queued operation to its end, recording each step as it finishes and a failure on the step that raised it.
 * Never throws: the project's alarm goes on to the next operation either way. */
export async function runQueuedOperation(env: Env, operation: CloudProjectOperation, request: unknown): Promise<void> {
  const userId = env.ACCOUNT_ID;
  const authority = env.PROJECT_AUTHORITY.getByName(`${userId}:${operation.projectId}`);
  const progress = operationProgress(authority, operation);
  const started = Date.now();
  const logged = { kind: operation.kind, operationId: operation.id, projectId: operation.projectId, workspaceId: operation.workspaceId };
  try {
    const kind = OperationKindSchema.safeParse(operation.kind);
    if (!kind.success) throw new Error(`GitSpace cannot run operation ${operation.kind}`);
    await progress.start(0);
    await RUNNERS[kind.data]({ env, userId, authority, operation, request, advance: progress.advance });
    await progress.advance();
    console.log(JSON.stringify({ event: 'operation_done', ...logged, ms: Date.now() - started }));
  } catch (error) {
    console.error(JSON.stringify({ event: 'operation_failed', ...logged, ms: Date.now() - started, message: failureMessage(error) }));
    await progress.fail(error);
  }
}

/** A ref the project repository lacks, brought in from the origin: read with an installation token when an installation
 * covers the origin, read anonymously when it is public, and only for a public origin that refuses (a private one the
 * App does not cover) through a machine holding the project's base checkout, which reads the origin with its own git
 * credentials. A covered origin never falls back to a machine. Either way the commit is read back from the project
 * repository. Null when the project has no origin. */
async function importOriginRef(env: Env, userId: string, code: ArtifactsCodeStore, project: CloudProjectSummary, ref: string): Promise<string | null> {
  if (!project.repositoryReference) return null;
  const access = await originAccess(env, project.repositoryReference);
  if (access.kind === 'github-app') return code.importSourceRef(project.id, access.remote, ref, originReadCredentials(access));
  try {
    return await code.importSourceRef(project.id, access.remote, ref, null);
  } catch (error) {
    if (!(error instanceof GitDiscoveryError) || !error.needsCredentials) throw error;
  }
  await env.SPACE_AUTHORITY.getByName(`${userId}:${project.id}`).runtimeImportRef({ projectId: project.id, workspaceId: project.id }, ref);
  const repository = artifactsProjectRepository(project.id);
  const commit = ref.startsWith('refs/heads/') ? await code.resolveRef(repository, ref) : await code.resolveAdvertisedRef(repository, ref);
  if (commit === null) throw new Error(`${ref} was imported but the project repository does not hold it`);
  return commit;
}

/** The commit a new workspace starts from, read from the cloud repositories only. */
async function resolveSource(env: Env, userId: string, code: ArtifactsCodeStore, project: CloudProjectSummary, sourceWorkspace: CloudWorkspaceDefinition | null, input: Pick<CloudWorkspaceRequest, 'sourceKind' | 'sourceRef'>): Promise<ResolvedSource> {
  if (sourceWorkspace) {
    const sourceRepository = artifactsWorkspaceRepository(sourceWorkspace.id);
    // The source workspace's checkpoint as its runtime holds it, uncommitted edits included; its own repository holds
    // those commits. A legacy workspace whose migration is staged but not activated has no runtime yet; its uploaded
    // repository already holds the verified closed branch, which a new workspace may start from.
    const checkpoint = await env.SPACE_AUTHORITY.getByName(`${userId}:${sourceWorkspace.id}`).runtimeRepositoryCheckpoint({ projectId: project.id, workspaceId: sourceWorkspace.id })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || !error.message.startsWith('Legacy migration is staged but not activated')) throw error;
        return null;
      });
    const headCommit = checkpoint ? checkpoint.headCommit : await code.resolveRef(sourceRepository, `refs/heads/${sourceWorkspace.branch}`);
    if (!headCommit) throw new Error(`Source workspace ${sourceWorkspace.name} has no commit to start from yet`);
    return { sourceRef: sourceWorkspace.id, sourceCommit: headCommit, repository: sourceRepository, checkpoint };
  }
  const repository = artifactsProjectRepository(project.id);
  const ref = checkedSourceRef(project, input);
  await ensureProjectCodeRepository(env, code, project);
  switch (input.sourceKind) {
    case 'base': {
      const commit = await code.resolveRef(repository, project.baseBranch === 'HEAD' ? 'HEAD' : `refs/heads/${project.baseBranch}`);
      if (commit === null && await code.resolveRef(repository, 'HEAD') !== null) throw new Error(`Base branch ${project.baseBranch} does not exist in the project repository`);
      return { sourceRef: ref, sourceCommit: commit, repository, checkpoint: null };
    }
    case 'branch': {
      const commit = await code.resolveRef(repository, `refs/heads/${ref}`) ?? await importOriginRef(env, userId, code, project, `refs/heads/${ref}`);
      if (commit === null) throw new Error(`Branch ${ref} does not exist in the project repository`);
      return { sourceRef: ref, sourceCommit: commit, repository, checkpoint: null };
    }
    case 'commit': {
      if (!await code.readCommit(repository, ref)) throw new Error(`Commit ${ref} does not exist in the project repository`);
      return { sourceRef: ref, sourceCommit: ref, repository, checkpoint: null };
    }
    case 'tag': {
      const commit = await code.resolveAdvertisedRef(repository, `refs/tags/${ref}`) ?? await importOriginRef(env, userId, code, project, `refs/tags/${ref}`);
      if (commit === null) throw new Error(`Tag ${ref} does not exist in the project repository`);
      return { sourceRef: ref, sourceCommit: commit, repository, checkpoint: null };
    }
    case 'pull-request': {
      const commit = await code.resolveAdvertisedRef(repository, `refs/pull/${ref}/head`) ?? await importOriginRef(env, userId, code, project, `refs/pull/${ref}/head`);
      if (commit === null) throw new Error(`Pull request #${ref} has no head in the project repository`);
      return { sourceRef: ref, sourceCommit: commit, repository, checkpoint: null };
    }
    case 'workspace': throw new Error(`Source workspace ${input.sourceRef} does not exist`);
  }
}

/** The ref a source names, checked without reading anything, so a request rejects a malformed source before it
 * queues a creation. */
function checkedSourceRef(project: CloudProjectSummary, input: Pick<CloudWorkspaceRequest, 'sourceKind' | 'sourceRef'>): string {
  switch (input.sourceKind) {
    case 'base': {
      // The base source has no ref of its own; a different one is a request for another source, never silently dropped.
      const requested = input.sourceRef.trim().replace(/^(?:refs\/heads\/|refs\/remotes\/origin\/|origin\/)/u, '');
      if (requested && requested !== project.baseBranch) throw new Error(`sourceKind base starts from the project base branch ${project.baseBranch}; to start from ${input.sourceRef}, use sourceKind branch with sourceRef ${requested}`);
      return project.baseBranch;
    }
    case 'branch': {
      // The cloud repository is the project's origin: `origin/` and remote-tracking forms name its branches.
      const branch = input.sourceRef.replace(/^(?:refs\/heads\/|refs\/remotes\/origin\/|origin\/)/u, '');
      if (!isSupportedBranchName(branch)) throw new Error(`${input.sourceRef} is not a branch of the project repository`);
      return branch;
    }
    case 'commit':
      if (!/^[0-9a-f]{40}$/u.test(input.sourceRef)) throw new Error('Enter the full 40-character commit ID');
      return input.sourceRef;
    case 'tag': {
      const tag = input.sourceRef.replace(/^refs\/tags\//u, '');
      if (!isSupportedBranchName(tag)) throw new Error(`${input.sourceRef} is not a valid tag name`);
      return tag;
    }
    case 'pull-request':
      if (!/^[1-9][0-9]*$/u.test(input.sourceRef)) throw new Error('Pull request source must be a positive pull request number');
      return input.sourceRef;
    case 'workspace': return input.sourceRef;
  }
}

/** A `workspace` source by id or name among the project's live worktrees. */
function findSourceWorkspace(worktrees: readonly CloudWorkspaceDefinition[], input: Pick<CloudWorkspaceRequest, 'sourceKind' | 'sourceRef'>): CloudWorkspaceDefinition | null {
  if (input.sourceKind !== 'workspace') return null;
  const source = worktrees.find(workspace => workspace.id === input.sourceRef) ?? worktrees.find(workspace => workspace.name === input.sourceRef);
  if (!source) throw new Error(`Source workspace ${input.sourceRef} does not exist`);
  return source;
}

/** Records a creation failed on the definition as it stands now, so Retry and Delete are offered. */
async function markCreationFailed(authority: ProjectAuthority, workspaceId: string): Promise<void> {
  const latest = await authority.getWorkspace(workspaceId);
  if (latest?.lifecycle !== 'provisioning') return;
  await authority.putWorkspace(revise(latest, { lifecycle: 'failed' }))
    .catch((recording: unknown) => console.error('Failed workspace creation was not recorded', { workspaceId, error: recording }));
}

/** The workspace a workspace operation acts on, as its project holds it now. */
async function operationWorkspace(authority: ProjectAuthority, operation: CloudProjectOperation): Promise<CloudWorkspaceDefinition> {
  const definition = operation.workspaceId === null ? null : await authority.getWorkspace(operation.workspaceId);
  if (!definition || definition.kind !== 'worktree') throw new CloudLifecycleTargetMissing('workspace', operation.workspaceId ?? operation.projectId);
  return definition;
}

/** Creation in the background: the source resolved in Artifacts, a repository forked from it with the workspace
 * branch at the source commit, then activation, which seeds the workspace object with its definition so it never
 * reads its project to learn what it is. Completed steps stay in place on failure; Retry resumes, Delete discards. A
 * recorded source commit is reused, except that a workspace source is read again so a retry starts from that
 * workspace's current state. */
async function runWorkspaceCreation({ env, userId, authority, operation, advance }: QueuedRun): Promise<void> {
  const definition = await operationWorkspace(authority, operation);
  if (definition.lifecycle !== 'provisioning') throw new Error(`Workspace ${definition.name} is ${definition.lifecycle}; only an unfinished creation runs`);
  try {
    const project = await requireActiveProject(authority, definition.projectId);
    const worktrees = (await authority.listWorkspaces()).filter(workspace => workspace.kind === 'worktree' && workspace.lifecycle !== 'deleting' && workspace.id !== definition.id);
    const sourceWorkspace = findSourceWorkspace(worktrees, definition);
    const code = new ArtifactsCodeStore(env.ARTIFACTS);
    let source: ResolvedSource;
    if (definition.sourceCommit === null || sourceWorkspace) source = await resolveSource(env, userId, code, project, sourceWorkspace, definition);
    else {
      await ensureProjectCodeRepository(env, code, project);
      source = { sourceRef: definition.sourceRef, sourceCommit: definition.sourceCommit, repository: artifactsProjectRepository(project.id), checkpoint: null };
    }
    const resolved = await authority.putWorkspace(revise(definition, { sourceRef: source.sourceRef, sourceCommit: source.sourceCommit }));
    await advance();
    await code.forkWorkspace(resolved.projectId, resolved.id, source.repository);
    await advance();
    // A fork can carry a same-named branch from its source; the workspace branch starts at its own source commit.
    if (resolved.sourceCommit !== null) await code.setBranch(artifactsWorkspaceRepository(resolved.id), resolved.branch, resolved.sourceCommit);
    await advance();
    const workspace = await authority.putWorkspace(revise(resolved, { lifecycle: 'active' }));
    await env.SPACE_AUTHORITY.getByName(`${userId}:${workspace.id}`).seedWorkspace(workspace, project, source.checkpoint);
  } catch (error) {
    await markCreationFailed(authority, definition.id);
    throw error;
  }
}

/** Records a workspace and queues its creation: the definition, relations and directory entry are written at once
 * (lifecycle `provisioning`), and the rest runs in the background (`runWorkspaceCreation`). Its runtime opens on first
 * use. Invalid names, branches, phases and malformed sources never enter the catalog. */
export async function createCloudWorkspace(env: Env, userId: string, input: CloudWorkspaceRequest): Promise<{ workspace: CloudWorkspaceDefinition; operation: CloudProjectOperation }> {
  const authority = await requireProject(env, userId, input.projectId);
  const name = input.name.trim();
  if (!name || name.length > 160) throw new Error('Enter a workspace name of at most 160 characters.');
  if (!isSupportedBranchName(input.branch)) throw new Error(`${input.branch} is not a valid branch name: use letters, digits, ".", "_", "-" and "/", without "..", "//", a component starting or ending with ".", or a ".lock" ending.`);
  const phase = WorkspacePhaseSchema.parse(input.phase ?? 'plan');
  const project = await requireActiveProject(authority, input.projectId);
  const worktrees = (await authority.listWorkspaces()).filter(workspace => workspace.kind === 'worktree' && workspace.lifecycle !== 'deleting');
  const sourceWorkspace = findSourceWorkspace(worktrees, input);
  const sourceRef = sourceWorkspace ? sourceWorkspace.id : checkedSourceRef(project, input);
  const dependencies = [...new Set([...(sourceWorkspace ? [sourceWorkspace.id] : []), ...(input.dependsOn ?? [])])].map(id => {
    const dependency = worktrees.find(workspace => workspace.id === id);
    if (!dependency) throw new Error(`Dependency workspace ${id} does not exist in project ${project.id}`);
    return dependency;
  });
  assertWorkspacePhase(phase, phaseCarriers(dependencies));
  const workspaceId = input.id ?? cloudResourceId(name);
  const definition = await authority.putWorkspace({
    id: workspaceId, projectId: project.id, kind: 'worktree', name, branch: input.branch, phase,
    sourceKind: input.sourceKind, sourceRef, sourceCommit: null,
    lifecycle: 'provisioning', goalId: null, expectedRevision: 0,
  });
  await env.USER_PROJECTS.getByName(userId).putWorkspaceLocation(workspaceId, project.id);
  if (dependencies.length > 0) {
    const related = await authority.setWorkspaceRelations(workspaceId, { dependsOn: dependencies.map(dependency => dependency.id), relatedTo: [], stackedOn: sourceWorkspace?.id ?? null });
    if (related.status === 'error') throw new Error(related.failure.message);
  }
  const operation = await queueOperation(authority, { projectId: project.id, workspaceId, kind: 'workspace.create', steps: WORKSPACE_CREATE_STEPS, summary: `${name} from ${sourceWorkspace ? sourceWorkspace.name : `${input.sourceKind} ${sourceRef}`}` });
  return { workspace: definition, operation };
}

/** Queues a failed or interrupted creation to run again from its first step; completed steps are reused. A creation
 * still queued or running is returned as it is, never queued twice. */
export async function retryCloudWorkspaceCreation(env: Env, userId: string, workspaceId: string): Promise<{ workspace: CloudWorkspaceDefinition; operation: CloudProjectOperation }> {
  const { authority, definition } = await requireWorktree(env, userId, workspaceId);
  if (definition.lifecycle !== 'failed' && definition.lifecycle !== 'provisioning') {
    throw new Error(`Workspace ${definition.name} is ${definition.lifecycle}; only a failed or unfinished creation can be retried`);
  }
  const running = (await authority.visibleOperations()).find(operation => operation.workspaceId === workspaceId && operation.kind === 'workspace.create' && (operation.state === 'queued' || operation.state === 'running'));
  if (running) return { workspace: definition, operation: running };
  await requireActiveProject(authority, definition.projectId);
  const workspace = definition.lifecycle === 'provisioning' ? definition : await authority.putWorkspace(revise(definition, { lifecycle: 'provisioning' }));
  const operation = await queueOperation(authority, { projectId: definition.projectId, workspaceId, kind: 'workspace.create', steps: WORKSPACE_CREATE_STEPS, summary: `${definition.name} from ${definition.sourceKind} ${definition.sourceRef}` });
  return { workspace, operation };
}

/** A legacy space held open by a machine is the only placement that can fence a cloud workspace lifecycle change. */
async function requireReleasedPlacement(env: Env, userId: string, workspaceId: string, expectedGeneration: number | null, absent: number | null): Promise<number> {
  const space = env.SPACE_AUTHORITY.getByName(`${userId}:${workspaceId}`);
  const placement = await space.get();
  const generation = placement?.generation ?? absent;
  if (generation !== expectedGeneration) throw new Error(`Workspace generation conflict: expected ${expectedGeneration}, actual ${generation}`);
  return requireCloudPlacement(env, userId, workspaceId);
}

/** A legacy space held open by a machine refuses cloud lifecycle changes until it is migrated; returns the generation. */
async function requireCloudPlacement(env: Env, userId: string, workspaceId: string): Promise<number> {
  const space = env.SPACE_AUTHORITY.getByName(`${userId}:${workspaceId}`);
  const placement = await space.get();
  if (placement?.machineId && !await space.hasCloudRuntime()) throw new Error('This legacy workspace must be migrated from its machine checkout before cloud lifecycle operations are available.');
  return placement?.generation ?? 0;
}

/** Queues archiving a workspace. The workspace object turns read-only and stops its runtime (working conversations
 * stop, caches are asked to detach) before it tells its project. */
export async function archiveCloudWorkspace(env: Env, userId: string, input: { projectId: string; spaceId: string; expectedGeneration: number | null }): Promise<CloudProjectOperation> {
  const authority = await requireProject(env, userId, input.projectId);
  const definition = await authority.getWorkspace(input.spaceId);
  if (!definition || definition.projectId !== input.projectId || definition.kind !== 'worktree' || definition.lifecycle === 'deleting') throw new CloudLifecycleTargetMissing('workspace', input.spaceId);
  if (definition.lifecycle !== 'active' && definition.lifecycle !== 'failed' && definition.lifecycle !== 'archived') throw new Error(`Workspace ${definition.name} is ${definition.lifecycle}; retry or delete its creation instead`);
  // A paused workspace refuses every read, its placement too; it is archived without starting (`archivePaused`).
  if (!(await env.SPACE_AUTHORITY.getByName(`${userId}:${definition.id}`).storageBreakerStatus()).quarantined) await requireReleasedPlacement(env, userId, definition.id, input.expectedGeneration, null);
  return queueOperation(authority, { projectId: input.projectId, workspaceId: definition.id, kind: 'workspace.archive', steps: labelled(['Stop workspace runtime and archive workspace']), summary: definition.name });
}

async function runWorkspaceArchive({ env, userId, authority, operation }: QueuedRun): Promise<void> {
  const definition = await operationWorkspace(authority, operation);
  if (definition.lifecycle === 'archived') return;
  const space = env.SPACE_AUTHORITY.getByName(`${userId}:${definition.id}`);
  if (!(await space.storageBreakerStatus()).quarantined) await requireCloudPlacement(env, userId, definition.id);
  await space.archiveWorkspace(definition);
}

/** Queues returning an archived workspace to active use: the workspace object accepts writes again, then tells its
 * project. Its runtime reopens on first use. */
export async function restoreCloudWorkspace(env: Env, userId: string, input: { spaceId: string; expectedGeneration: number }): Promise<CloudProjectOperation> {
  const { authority, definition } = await requireWorktree(env, userId, input.spaceId);
  await requireReleasedPlacement(env, userId, definition.id, input.expectedGeneration, 0);
  if (definition.lifecycle !== 'archived' && definition.lifecycle !== 'active') throw new Error(`Workspace ${definition.name} is ${definition.lifecycle}; only an archived workspace can be restored`);
  return queueOperation(authority, { projectId: definition.projectId, workspaceId: definition.id, kind: 'workspace.restore', steps: labelled(['Restore workspace']), summary: definition.name });
}

async function runWorkspaceRestore({ env, userId, authority, operation }: QueuedRun): Promise<void> {
  const definition = await operationWorkspace(authority, operation);
  if (definition.lifecycle === 'active') return;
  if (definition.lifecycle !== 'archived') throw new Error(`Workspace ${definition.name} is ${definition.lifecycle}; only an archived workspace can be restored`);
  await requireCloudPlacement(env, userId, definition.id);
  await env.SPACE_AUTHORITY.getByName(`${userId}:${definition.id}`).restoreWorkspace(definition);
}

/** Queues permanently deleting a workspace in any state: its runtime state, caches, repository and definition. */
export async function deleteCloudWorkspace(env: Env, userId: string, workspaceId: string): Promise<CloudProjectOperation> {
  const { authority, definition } = await requireWorktree(env, userId, workspaceId);
  return queueOperation(authority, { projectId: definition.projectId, workspaceId, kind: 'workspace.delete', steps: labelled(['Erase workspace runtime', 'Delete workspace repository', 'Delete workspace authority']), summary: definition.name });
}

/** The workspace object stops its runtime and erases its state before its project records it deleting. */
async function runWorkspaceDelete({ env, userId, authority, operation, advance }: QueuedRun): Promise<void> {
  const workspaceId = operation.workspaceId ?? '';
  const definition = await authority.getWorkspace(workspaceId);
  // Already gone: a run cut off after removing the definition finishes the cleanup.
  if (definition) await env.SPACE_AUTHORITY.getByName(`${userId}:${workspaceId}`).deleteWorkspace(definition);
  await advance();
  await new ArtifactsCodeStore(env.ARTIFACTS).deleteRepository(artifactsWorkspaceRepository(workspaceId));
  await advance();
  if (definition) await authority.removeWorkspace(workspaceId);
  await env.USER_PROJECTS.getByName(userId).removeWorkspaceLocation(workspaceId);
  // Its drive and workspace objects become unreadable with their key.
  await forgetTenantScope(env, `space:${workspaceId}`);
}

/** The project a project operation's request names, checked against the revision the caller saw. The run itself uses
 * the revision current when it runs: origin checks move it while the operation waits. */
async function requireProjectAt(authority: ProjectAuthority, projectId: string, expectedRevision: number): Promise<CloudProjectSummary> {
  const project = await authority.getProject();
  if (!project || project.lifecycle === 'deleting') throw new CloudLifecycleTargetMissing('project', projectId);
  if (project.revision !== expectedRevision) throw new Error(`Project revision conflict: expected ${expectedRevision}, actual ${project.revision}`);
  return project;
}

/** Queues archiving a project: every workspace object turns read-only and stops its runtime, its caches asked to
 * detach; workspace lifecycles are kept. */
export async function archiveCloudProject(env: Env, userId: string, projectId: string, expectedRevision: number): Promise<CloudProjectOperation> {
  const authority = await requireProject(env, userId, projectId);
  const project = await requireProjectAt(authority, projectId, expectedRevision);
  if (project.role === GITSPACE_SOURCE_PROJECT_ROLE) throw new Error('The built-in GitSpace project cannot be archived or deleted. Release its machine caches instead.');
  if (project.lifecycle !== 'active' && project.lifecycle !== 'archiving') throw new Error(`Project ${project.name} is ${project.lifecycle}; only an active project can be archived`);
  return queueOperation(authority, { projectId, workspaceId: null, kind: 'project.archive', steps: labelled(['Stop workspace runtimes', 'Archive project']), summary: project.name });
}

/** Each workspace is asked from here, never by the project authority. */
async function runProjectArchive({ env, userId, authority, operation, advance }: QueuedRun): Promise<void> {
  const { projectId } = operation;
  const project = await authority.getProject();
  if (!project || project.lifecycle === 'deleting') throw new CloudLifecycleTargetMissing('project', projectId);
  const archiving = await authority.setProjectLifecycle(project.revision, 'archiving');
  for (const workspace of await authority.listWorkspaces()) {
    if (workspace.lifecycle !== 'deleting') await env.SPACE_AUTHORITY.getByName(`${userId}:${workspace.id}`).applyProjectLifecycle({ projectId, workspaceId: workspace.id }, { lifecycle: 'archived', revision: archiving.revision });
  }
  await advance();
  await env.USER_PROJECTS.getByName(userId).put(await authority.setProjectLifecycle(archiving.revision, 'archived'));
}

/** Queues restoring an archived project. */
export async function restoreCloudProject(env: Env, userId: string, projectId: string, expectedRevision: number): Promise<CloudProjectOperation> {
  const authority = await requireProject(env, userId, projectId);
  const project = await requireProjectAt(authority, projectId, expectedRevision);
  if (project.lifecycle !== 'archived' && project.lifecycle !== 'restoring') throw new Error(`Project ${projectId} is ${project.lifecycle}; only an archived project can be restored`);
  return queueOperation(authority, { projectId, workspaceId: null, kind: 'project.restore', steps: labelled(['Restore workspaces', 'Restore project']), summary: project.name });
}

/** Every workspace object accepts writes again before the project turns active, so an interrupted restore stays
 * `restoring` and is retried. */
async function runProjectRestore({ env, userId, authority, operation, advance }: QueuedRun): Promise<void> {
  const { projectId } = operation;
  const project = await authority.getProject();
  if (!project || project.lifecycle === 'deleting') throw new CloudLifecycleTargetMissing('project', projectId);
  const restoring = await authority.setProjectLifecycle(project.revision, 'restoring');
  for (const workspace of await authority.listWorkspaces()) {
    if (workspace.lifecycle !== 'deleting') await env.SPACE_AUTHORITY.getByName(`${userId}:${workspace.id}`).applyProjectLifecycle({ projectId, workspaceId: workspace.id }, { lifecycle: 'active', revision: restoring.revision });
  }
  await advance();
  await env.USER_PROJECTS.getByName(userId).put(await authority.setProjectLifecycle(restoring.revision, 'active'));
}

const SetBaseBranchRequestSchema = z.object({ baseBranch: z.string() });

/** Queues switching the project's base branch. Existing workspaces keep their branches. */
export async function setCloudProjectBaseBranch(env: Env, userId: string, projectId: string, expectedRevision: number, baseBranch: string): Promise<CloudProjectOperation> {
  const authority = await requireProject(env, userId, projectId);
  if (!isSupportedBranchName(baseBranch)) throw new Error(`${baseBranch} is not a valid branch name`);
  const project = await requireProjectAt(authority, projectId, expectedRevision);
  if (project.lifecycle !== 'active') throw new Error(`Project ${project.name} is ${project.lifecycle}; its base branch changes only while it is active`);
  return queueOperation(authority, {
    projectId, workspaceId: null, kind: 'project.setBaseBranch',
    steps: labelled([`Copy ${baseBranch} from the origin`, 'Switch the base checkout and record the branch']),
    summary: `${project.baseBranch} → ${baseBranch}`, request: { baseBranch },
  });
}

/** The branch is copied into the project repository first (the long part on a large origin), then the base checkout
 * changes only when clean and idle; its authority owns serialization and recovery across refs, checkpoint and project
 * metadata. */
async function runProjectSetBaseBranch({ env, userId, authority, operation, request, advance }: QueuedRun): Promise<void> {
  const { projectId } = operation;
  const { baseBranch } = SetBaseBranchRequestSchema.parse(request);
  const project = await requireActiveProject(authority, projectId);
  const code = new ArtifactsCodeStore(env.ARTIFACTS);
  await ensureProjectCodeRepository(env, code, project);
  const ref = `refs/heads/${baseBranch}`;
  if (await code.resolveRef(artifactsProjectRepository(projectId), ref) === null && await importOriginRef(env, userId, code, project, ref) === null) {
    throw new Error(`Branch ${baseBranch} does not exist in the project repository or its origin`);
  }
  await advance();
  await env.SPACE_AUTHORITY.getByName(`${userId}:${projectId}`).runtimeSetBaseBranch({ projectId, workspaceId: projectId }, project.revision, baseBranch);
}

/** The project's origin moves to `repositoryUrl` (a fork, a moved repository); its workspaces keep their branches and
 * the base space reads from the new origin from now on. The new origin is read at once, as Check origin would. */
export async function setCloudProjectRepository(env: Env, userId: string, projectId: string, expectedRevision: number, repositoryUrl: string): Promise<CloudProjectSummary> {
  const authority = await requireProject(env, userId, projectId);
  const updated = await env.USER_PROJECTS.getByName(userId).put(await authority.setRepository(expectedRevision, repositoryUrl));
  await refreshProjectRemote(env, userId, projectId).catch((error: unknown) => {
    console.warn(JSON.stringify({ event: 'project_repository_check_failed', projectId, message: error instanceof Error ? error.message : String(error) }));
  });
  return (await authority.getProject()) ?? updated;
}

/** Queues Update base after checking the project has an origin branch to read. */
export async function updateCloudProjectBase(env: Env, userId: string, projectId: string): Promise<CloudProjectOperation> {
  const authority = await requireProject(env, userId, projectId);
  const project = await requireActiveProject(authority, projectId);
  if (project.repositoryReference === null) throw new Error(`Project ${project.name} has no origin to update its base from`);
  if (!isSupportedBranchName(project.baseBranch)) throw new Error(`Base branch ${project.baseBranch} cannot be read from the origin by name`);
  return queueOperation(authority, {
    projectId, workspaceId: null, kind: 'project.updateBase',
    steps: labelled(['Fast-forward the project base branch from origin', 'Move the clean base checkout']),
    summary: `${project.baseBranch} from origin`,
  });
}

/** Update base: the project's copy of its base branch moves to the origin's head only as a fast-forward (a copy with
 * commits the origin lacks is refused), then the clean idle base checkout follows through the base-branch change's
 * same-branch refresh. A busy or dirty base workspace is left for later: the copy stays updated, the operation fails
 * saying so, and running Update base again moves it. One project notice reports the outcome. */
async function runProjectUpdateBase({ env, userId, authority, operation, advance }: QueuedRun): Promise<void> {
  const { projectId } = operation;
  const project = await requireActiveProject(authority, projectId);
  const reference = project.repositoryReference;
  if (reference === null) throw new Error(`Project ${project.name} has no origin to update its base from`);
  const branch = project.baseBranch;
  const identity = { projectId, workspaceId: projectId };
  const space = env.SPACE_AUTHORITY.getByName(`${userId}:${projectId}`);
  const code = new ArtifactsCodeStore(env.ARTIFACTS);
  await ensureProjectCodeRepository(env, code, project);
  const repository = artifactsProjectRepository(projectId);
  const ref = `refs/heads/${branch}`;
  const previous = await code.resolveRef(repository, ref);
  const access = await originAccess(env, reference);
  const head = await code.fetchOriginBranch(projectId, access.remote, branch, originReadCredentials(access));
  const position: ForwardPosition = previous === null ? { kind: 'forward' } : await forwardPosition(code, [repository], previous, head);
  if (position.kind === 'diverged') {
    throw new Error(position.ahead === null
      ? `GitSpace cannot tell whether origin's ${branch} (${head.slice(0, 7)}) fast-forwards the project's copy: its cloud history is incomplete, so it was not moved.`
      : `The project's ${branch} has ${position.ahead} ${position.ahead === 1 ? 'commit' : 'commits'} that origin's ${branch} (${head.slice(0, 7)}) lacks, so it was not moved: GitSpace only fast-forwards it. Push those commits to origin, then update again.`);
  }
  if (position.kind === 'forward') await code.copyCommit(repository, repository, ref, head, previous);
  await advance();
  let left: string | null = null;
  try { await space.runtimeSetBaseBranch(identity, project.revision, branch); }
  catch (error) { left = failureMessage(error); }
  // The origin head was read just now: record it, which recomputes what is behind it against the moved copy.
  await authority.recordRemoteHeads([{ branch, head }]);
  const outcome = position.kind === 'forward' ? `Base branch ${branch} updated to ${head.slice(0, 7)} from origin.` : `Base branch ${branch} already holds origin's ${head.slice(0, 7)}.`;
  const text = left === null ? outcome : `${outcome} The base workspace was left for later: ${left}`;
  await space.runtimeProjectNotice(identity, text);
  // A moved base can mean a stack parent merged: what is stacked is told, without waking.
  if (position.kind === 'forward') await noticeStackChanges(env, userId, projectId, projectId).catch((error: unknown) => console.error('Stack notices were not sent', { projectId, error }));
  if (left !== null) throw new Error(text);
}

/** Queues permanently deleting a project in any state. */
export async function deleteCloudProject(env: Env, userId: string, projectId: string, expectedRevision: number): Promise<CloudProjectOperation> {
  const authority = await requireProject(env, userId, projectId);
  const project = await requireProjectAt(authority, projectId, expectedRevision);
  if (project.role === GITSPACE_SOURCE_PROJECT_ROLE) throw new Error('The built-in GitSpace project cannot be deleted. Release its machine caches instead.');
  return queueOperation(authority, { projectId, workspaceId: null, kind: 'project.delete', steps: labelled(['Erase workspaces', 'Delete project repository and automations']), summary: project.name });
}

/** Every workspace's runtime state and repository go, then the project's, then its directory entry. The tombstone
 * keeps the project's operations, so this one records its end. */
async function runProjectDelete({ env, userId, authority, operation, advance }: QueuedRun): Promise<void> {
  const { projectId } = operation;
  const project = await authority.getProject();
  if (!project) throw new CloudLifecycleTargetMissing('project', projectId);
  const workspaces = await authority.listWorkspaces();
  const code = new ArtifactsCodeStore(env.ARTIFACTS);
  // Each workspace object marks itself unavailable and erases its runtime before the authority tombstone removes its definition.
  for (const workspace of workspaces) {
    await env.SPACE_AUTHORITY.getByName(`${userId}:${workspace.id}`).runtimeErase({ projectId, workspaceId: workspace.id });
    await code.deleteRepository(artifactsWorkspaceRepository(workspace.id));
  }
  await authority.deleteProject(project.revision);
  await advance();
  await code.deleteRepository(artifactsProjectRepository(projectId));
  // Its automations stop with it: their alarm goes, so no schedule fires into the deleted project.
  await env.PROJECT_AUTOMATIONS.getByName(`${userId}:${projectId}`).erase();
  await env.USER_PROJECTS.getByName(userId).remove(projectId);
  // Every drive, workspace and LFS object of the project becomes unreadable with its scope's key.
  for (const scope of [`lfs:${projectId}`, `space:${projectId}`, ...workspaces.map(workspace => `space:${workspace.id}`)]) await forgetTenantScope(env, scope);
}

const RUNNERS: Record<OperationKind, (run: QueuedRun) => Promise<void>> = {
  'workspace.create': runWorkspaceCreation,
  'workspace.archive': runWorkspaceArchive,
  'workspace.restore': runWorkspaceRestore,
  'workspace.delete': runWorkspaceDelete,
  'project.archive': runProjectArchive,
  'project.restore': runProjectRestore,
  'project.setBaseBranch': runProjectSetBaseBranch,
  'project.updateBase': runProjectUpdateBase,
  'project.delete': runProjectDelete,
  'project.import': runProjectImport,
};

/** The project repository's first import: the origin's base branch copied into the project's cloud repository. */
async function runProjectImport({ env, authority, operation }: QueuedRun): Promise<void> {
  const project = await authority.getProject();
  if (!project || project.lifecycle === 'deleting') throw new CloudLifecycleTargetMissing('project', operation.projectId);
  await ensureProjectCodeRepository(env, new ArtifactsCodeStore(env.ARTIFACTS), project);
}

/** A project repository that holds its origin's history, imported first when it does not. The first import runs as a
 * project operation, so it shows where operations show and one import serves every workspace that opens meanwhile;
 * its failure is thrown here, and the next call imports again. */
export async function importedProjectRepository(env: Env, project: CloudProjectSummary): Promise<void> {
  const code = new ArtifactsCodeStore(env.ARTIFACTS);
  if (project.repositoryReference === null) { await ensureProjectCodeRepository(env, code, project); return; }
  if (await code.projectImported(project.id, project.baseBranch)) return;
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${project.id}`);
  const running = (await authority.visibleOperations()).find(operation => operation.kind === 'project.import' && (operation.state === 'queued' || operation.state === 'running'));
  // Queued beside any other change: the project's alarm runs its operations one at a time.
  const operation = running ?? await authority.queueOperation({
    projectId: project.id, workspaceId: null, kind: 'project.import', steps: labelled([`Import ${project.baseBranch === 'HEAD' ? 'the default branch' : project.baseBranch} from the origin`]),
    summary: project.repositoryReference, request: {}, createdBy: 'account',
  });
  await completedOperation(env, operation);
}

/** Queues a failed operation again with the request it was given; its own checks run again first. */
export async function retryCloudOperation(env: Env, userId: string, projectId: string, operationId: string): Promise<CloudProjectOperation> {
  const authority = await requireProject(env, userId, projectId);
  const failed = await projectOperationOf(authority, projectId, operationId);
  if (failed.state !== 'failed') throw new Error(`Operation ${operationId} is ${failed.state}; only a failed operation can be retried`);
  const kind = OperationKindSchema.safeParse(failed.kind);
  if (!kind.success) throw new Error(`Operation ${failed.kind} cannot be retried`);
  if (kind.data === 'workspace.create') return (await retryCloudWorkspaceCreation(env, userId, failed.workspaceId ?? '')).operation;
  const steps = failed.steps.map(step => ({ id: step.id, label: step.label }));
  const request = await authority.operationRequest(operationId);
  // The views drop a failure a later operation of its kind on its target followed (`visibleOperations`).
  return queueOperation(authority, { projectId, workspaceId: failed.workspaceId, kind: kind.data, steps, summary: failed.summary, request: z.record(z.string(), z.unknown()).parse(request ?? {}) });
}

/** One of the project's operations; a missing one is an error, not a not-found project. */
async function projectOperationOf(authority: ProjectAuthority, projectId: string, operationId: string): Promise<CloudProjectOperation> {
  const operation = await authority.getOperation(operationId).catch(() => null);
  if (!operation || operation.projectId !== projectId) throw new Error(`Operation ${operationId} does not exist in project ${projectId}`);
  return operation;
}

export async function readCloudOperation(env: Env, userId: string, projectId: string, operationId: string): Promise<CloudProjectOperation> {
  return projectOperationOf(await requireProject(env, userId, projectId), projectId, operationId);
}

/** Stops showing an operation in the project's views; a queued or running one cannot be dismissed. */
export async function dismissCloudOperation(env: Env, userId: string, projectId: string, operationId: string): Promise<void> {
  const authority = await requireProject(env, userId, projectId);
  const operation = await projectOperationOf(authority, projectId, operationId);
  if (operation.state === 'queued' || operation.state === 'running') throw new Error(`Operation ${operationId} is still ${operation.state}`);
  await authority.dismissOperation(operationId);
}

/** Moves a workspace's phase within the ceiling its dependencies set: the workspace object applies it, then its
 * project records it. */
export async function setCloudWorkspacePhase(env: Env, userId: string, identity: RuntimeIdentity, phase: WorkspacePhase): Promise<CloudWorkspaceDefinition> {
  return env.SPACE_AUTHORITY.getByName(`${userId}:${identity.workspaceId}`).setWorkspacePhase(identity, phase);
}

/** How long a caller that needs a change done before it goes on (an agent's tool call, an automation) waits for it. */
const OPERATION_WAIT_MS = 120_000;

/** The operation once it succeeds or fails, or as it stands after `OPERATION_WAIT_MS`. Reads every 50 ms at first,
 * doubling to once a second: most creations end within a second. */
async function settledOperation(authority: ProjectAuthority, operationId: string): Promise<CloudProjectOperation> {
  const deadline = Date.now() + OPERATION_WAIT_MS;
  for (let pause = 50; ; pause = Math.min(1_000, pause * 2)) {
    const operation = await authority.getOperation(operationId);
    if (operation.state === 'succeeded' || operation.state === 'failed' || Date.now() >= deadline) return operation;
    const paused = Promise.withResolvers<void>();
    setTimeout(paused.resolve, pause);
    await paused.promise;
  }
}

/** Waits for an operation its caller needs done before it goes on; throws its failure, or that it is still running. */
export async function completedOperation(env: Env, operation: CloudProjectOperation): Promise<void> {
  const settled = await settledOperation(env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${operation.projectId}`), operation.id);
  if (settled.state === 'succeeded') return;
  throw new Error(settled.error ?? `${settled.kind} is still ${settled.state} after ${OPERATION_WAIT_MS / 1000} seconds; it goes on in the background`);
}

/** The agent's `space_workspace` changes. `create` adds a workspace to the agent's project with its first instruction
 * records, written as `actorId`; the others act on `workspaceId`, or the agent's own workspace, within the agent's project. */
export async function changeAgentWorkspace(env: Env, identity: RuntimeIdentity, request: z.infer<typeof RuntimeWorkspaceMutationArgumentsSchema>, actorId: string): Promise<unknown> {
  const userId = env.ACCOUNT_ID;
  const authority = env.PROJECT_AUTHORITY.getByName(`${userId}:${identity.projectId}`);
  if (request.method === 'create') {
    const { method: _method, workspaceId: _workspaceId, on: _on, goal, workflow, rubric, ...workspace } = request;
    const queued = await createCloudWorkspace(env, userId, { ...workspace, projectId: identity.projectId });
    // An agent's tool call is not a browser request: it waits for the creation, so `ready` still means created.
    const operation = await settledOperation(authority, queued.operation.id);
    const created = { workspace: await authority.getWorkspace(queued.workspace.id) ?? queued.workspace, operation };
    const owned = { projectId: identity.projectId, spaceId: created.workspace.id };
    if (operation.state !== 'succeeded') {
      return { ...created, identity: owned, ready: false, initialized: [], error: { operation: 'workspace.create', message: operation.error ?? `Creation is still ${operation.state} after ${OPERATION_WAIT_MS / 1000} seconds; it goes on in the background`,
        recovery: operation.state === 'failed' ? 'Retry the creation (retryCreate) or delete the workspace; do not create it again.' : 'Read the workspace later; do not create it again.' } };
    }
    const context = env.SPACE_CONTEXT.getByName(JSON.stringify([userId, owned.projectId, owned.spaceId]));
    const initialized: string[] = [];
    let initializing = 'goal';
    const publish = async (entity: string, value: { id: string; revision: number }) => {
      await authority.appendEvent({ scope: 'workspace', entity, entityId: value.id, revision: value.revision, operation: 'updated', payload: { spaceId: owned.spaceId } });
      initialized.push(entity);
    };
    try {
      if (goal) await publish('goal', await context.putGoal({ ...owned, expectedRevision: 0, goal: { ...goal, updatedBy: actorId } }));
      initializing = 'workflow';
      if (workflow) await publish('workflow', await context.putWorkflow({ ...owned, expectedRevision: 0, workflow: { ...workflow, updatedBy: actorId } }));
      initializing = 'rubric';
      if (rubric) await publish('rubric', await context.putRubric({ ...owned, expectedRevision: 0, rubric: { ...rubric, updatedBy: actorId } }));
      return { ...created, identity: owned, ready: true, initialized };
    } catch (error) {
      return { ...created, identity: owned, ready: false, initialized, error: { operation: `${initializing}.put`, message: failureMessage(error),
        recovery: 'The workspace exists. Read its latest records and reconcile the incomplete instruction writes; do not recreate it.' } };
    }
  }
  const workspaces = await authority.listWorkspaces();
  const definition = workspaces.find(workspace => workspace.id === (request.workspaceId ?? identity.workspaceId) && workspace.kind === 'worktree');
  if (!definition) throw new Error('Workspace changes require a workspace in the current project');
  switch (request.method) {
    case 'restore': return restoreCloudWorkspace(env, userId, { spaceId: definition.id, expectedGeneration: request.expectedGeneration });
    case 'open':
      // The agent runs in this workspace's cloud runtime, so it is already open unless archived.
      if (definition.lifecycle === 'archived') throw new Error('Archived workspaces must be restored before opening');
      await requireReleasedPlacement(env, userId, definition.id, request.expectedGeneration, 0);
      return definition;
    case 'setRelations': {
      if (definition.revision !== request.expectedRevision) throw new Error(`Workspace revision conflict: expected ${request.expectedRevision}, actual ${definition.revision}`);
      const dependsOn = new Set([...request.dependsOn, ...(request.stackedOn ? [request.stackedOn] : [])]);
      assertWorkspacePhase(definition.phase ?? 'plan', phaseCarriers(workspaces.filter(workspace => dependsOn.has(workspace.id))));
      const related = await authority.setWorkspaceRelations(definition.id, { dependsOn: request.dependsOn, relatedTo: request.relatedTo, stackedOn: request.stackedOn });
      if (related.status === 'error') throw new Error(related.failure.message);
      return { ...definition, relations: related.value };
    }
  }
}
