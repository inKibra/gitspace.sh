import type { z } from 'zod';
import type { CloudProjectOperation, CloudProjectSummary, CloudWorkspaceDefinition } from '@gitspace/protocol';
import { cloudResourceId, normalizeRemoteRepositoryUrl } from '@gitspace/protocol';
import type { RuntimeWorkspaceMutationArgumentsSchema } from '@gitspace/protocol/inspector-contract';
import type { RuntimeGitCheckpoint, RuntimeSnapshot } from '@gitspace/protocol-runtime';
import { assertWorkspacePhase, WorkspacePhaseSchema, type WorkspacePhase } from '@gitspace/protocol-workspace';
import { ArtifactsCodeStore, artifactsProjectRepository, artifactsWorkspaceRepository, isSupportedBranchName } from '@gitspace/runtime-workspace-do';
import { ensureProjectCodeRepository } from './account-runtime-host.js';
import type { ProjectAuthorityDO } from './project-authority.js';
import type { SpaceAuthorityDO } from './space-authority.js';

type ProjectAuthority = DurableObjectStub<ProjectAuthorityDO>;
type SpaceAuthority = DurableObjectStub<SpaceAuthorityDO>;
type RuntimeIdentity = Pick<RuntimeSnapshot, 'projectId' | 'workspaceId'>;

/** Creation steps in order. The source resolves before the definition enters the catalog, so progress starts at
 * `repository`; every step is idempotent, so a retry repeats them all and resumes where the last attempt failed. */
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
function revise(definition: CloudWorkspaceDefinition, change: Partial<Pick<CloudWorkspaceDefinition, 'lifecycle' | 'sourceCommit'>>) {
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

/** Runs a lifecycle change as a recorded operation with one step per label. */
async function runOperation<T>(authority: ProjectAuthority, input: { projectId: string; workspaceId: string | null; kind: string; labels: readonly string[] }, run: (advance: () => Promise<unknown>) => Promise<T>): Promise<T> {
  const progress = operationProgress(authority, await authority.createOperation({
    projectId: input.projectId, workspaceId: input.workspaceId, kind: input.kind,
    steps: input.labels.map((label, index) => ({ id: `step-${index + 1}`, label })), createdBy: 'account',
  }));
  await progress.start(0);
  try {
    const value = await run(progress.advance);
    await progress.advance();
    return value;
  } catch (error) {
    await progress.fail(error);
    throw error;
  }
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
  await ensureProjectCodeRepository(code, project);
  switch (input.sourceKind) {
    case 'base': {
      const commit = await code.resolveRef(repository, project.baseBranch === 'HEAD' ? 'HEAD' : `refs/heads/${project.baseBranch}`);
      if (commit === null && await code.resolveRef(repository, 'HEAD') !== null) throw new Error(`Base branch ${project.baseBranch} does not exist in the project repository`);
      return { sourceRef: project.baseBranch, sourceCommit: commit, repository, checkpoint: null };
    }
    case 'branch': {
      // The cloud repository is the project's origin: `origin/` and remote-tracking forms name its branches.
      const branch = input.sourceRef.replace(/^(?:refs\/heads\/|refs\/remotes\/origin\/|origin\/)/u, '');
      if (!isSupportedBranchName(branch)) throw new Error(`${input.sourceRef} is not a branch of the project repository`);
      const commit = await code.resolveRef(repository, `refs/heads/${branch}`)
        ?? (project.repositoryReference ? await code.importSourceRef(project.id, normalizeRemoteRepositoryUrl(project.repositoryReference.replace(/^git@github\.com:/u, 'https://github.com/')), `refs/heads/${branch}`) : null);
      if (commit === null) throw new Error(`Branch ${branch} does not exist in the project repository`);
      return { sourceRef: branch, sourceCommit: commit, repository, checkpoint: null };
    }
    case 'commit': {
      if (!/^[0-9a-f]{40}$/u.test(input.sourceRef)) throw new Error('Enter the full 40-character commit ID');
      if (!await code.readCommit(repository, input.sourceRef)) throw new Error(`Commit ${input.sourceRef} does not exist in the project repository`);
      return { sourceRef: input.sourceRef, sourceCommit: input.sourceRef, repository, checkpoint: null };
    }
    case 'tag': {
      const tag = input.sourceRef.replace(/^refs\/tags\//u, '');
      if (!isSupportedBranchName(tag)) throw new Error(`${input.sourceRef} is not a valid tag name`);
      const commit = await code.resolveAdvertisedRef(repository, `refs/tags/${tag}`)
        ?? (project.repositoryReference ? await code.importSourceRef(project.id, normalizeRemoteRepositoryUrl(project.repositoryReference.replace(/^git@github\.com:/u, 'https://github.com/')), `refs/tags/${tag}`) : null);
      if (commit === null) throw new Error(`Tag ${tag} does not exist in the project repository`);
      return { sourceRef: tag, sourceCommit: commit, repository, checkpoint: null };
    }
    case 'pull-request': {
      if (!/^[1-9][0-9]*$/u.test(input.sourceRef)) throw new Error('Pull request source must be a positive pull request number');
      const commit = await code.resolveAdvertisedRef(repository, `refs/pull/${input.sourceRef}/head`)
        ?? (project.repositoryReference ? await code.importSourceRef(project.id, normalizeRemoteRepositoryUrl(project.repositoryReference.replace(/^git@github\.com:/u, 'https://github.com/')), `refs/pull/${input.sourceRef}/head`) : null);
      if (commit === null) throw new Error(`Pull request #${input.sourceRef} has no head in the project repository`);
      return { sourceRef: input.sourceRef, sourceCommit: commit, repository, checkpoint: null };
    }
    case 'workspace': throw new Error(`Source workspace ${input.sourceRef} does not exist`);
  }
}

/** A `workspace` source by id or name among the project's live worktrees. */
function findSourceWorkspace(worktrees: readonly CloudWorkspaceDefinition[], input: Pick<CloudWorkspaceRequest, 'sourceKind' | 'sourceRef'>): CloudWorkspaceDefinition | null {
  if (input.sourceKind !== 'workspace') return null;
  const source = worktrees.find(workspace => workspace.id === input.sourceRef) ?? worktrees.find(workspace => workspace.name === input.sourceRef);
  if (!source) throw new Error(`Source workspace ${input.sourceRef} does not exist`);
  return source;
}

/** Runs creation from the repository step: fork, branch at the source commit, activate. Activation seeds the workspace
 * object with its definition, so it never reads its project to learn what it is. */
async function provisionWorkspace(authority: ProjectAuthority, space: SpaceAuthority, project: CloudProjectSummary, code: ArtifactsCodeStore, definition: CloudWorkspaceDefinition, source: ResolvedSource, created: CloudProjectOperation): Promise<{ workspace: CloudWorkspaceDefinition; operation: CloudProjectOperation }> {
  const progress = operationProgress(authority, created);
  try {
    await progress.start(1);
    await code.forkWorkspace(definition.projectId, definition.id, source.repository);
    await progress.advance();
    // A fork can carry a same-named branch from its source; the workspace branch starts at its own source commit.
    if (definition.sourceCommit !== null) await code.setBranch(artifactsWorkspaceRepository(definition.id), definition.branch, definition.sourceCommit);
    await progress.advance();
    const workspace = await authority.putWorkspace(revise(definition, { lifecycle: 'active' }));
    await space.seedWorkspace(workspace, project, source.checkpoint);
    return { workspace, operation: await progress.advance() };
  } catch (error) {
    // Completed steps stay in place; Retry resumes, Delete discards.
    await progress.fail(error);
    await authority.putWorkspace(revise(definition, { lifecycle: 'failed' }))
      .catch((recording: unknown) => console.error('Failed workspace creation was not recorded', { workspaceId: definition.id, error: recording }));
    throw error;
  }
}

/** Creates a workspace entirely in the cloud: its source resolved in Artifacts, its canonical definition, relations
 * and directory entry, and a repository forked from its source with the workspace branch at the source commit. Its
 * runtime opens on first use. Invalid branches, sources and phases never enter the catalog. */
export async function createCloudWorkspace(env: Env, userId: string, input: CloudWorkspaceRequest): Promise<{ workspace: CloudWorkspaceDefinition; operation: CloudProjectOperation }> {
  const authority = await requireProject(env, userId, input.projectId);
  const name = input.name.trim();
  if (!name || name.length > 160) throw new Error('Enter a workspace name of at most 160 characters.');
  if (!isSupportedBranchName(input.branch)) throw new Error(`${input.branch} is not a valid branch name: use letters, digits, ".", "_", "-" and "/", without "..", "//", a component starting or ending with ".", or a ".lock" ending.`);
  const phase = WorkspacePhaseSchema.parse(input.phase ?? 'plan');
  const project = await requireActiveProject(authority, input.projectId);
  const worktrees = (await authority.listWorkspaces()).filter(workspace => workspace.kind === 'worktree' && workspace.lifecycle !== 'deleting');
  const sourceWorkspace = findSourceWorkspace(worktrees, input);
  const dependencies = [...new Set([...(sourceWorkspace ? [sourceWorkspace.id] : []), ...(input.dependsOn ?? [])])].map(id => {
    const dependency = worktrees.find(workspace => workspace.id === id);
    if (!dependency) throw new Error(`Dependency workspace ${id} does not exist in project ${project.id}`);
    return dependency;
  });
  assertWorkspacePhase(phase, phaseCarriers(dependencies));
  const code = new ArtifactsCodeStore(env.ARTIFACTS);
  const source = await resolveSource(env, userId, code, project, sourceWorkspace, input);
  const workspaceId = cloudResourceId(name);
  const definition = await authority.putWorkspace({
    id: workspaceId, projectId: project.id, kind: 'worktree', name, branch: input.branch, phase,
    sourceKind: input.sourceKind, sourceRef: source.sourceRef, sourceCommit: source.sourceCommit,
    lifecycle: 'provisioning', goalId: null, expectedRevision: 0,
  });
  await env.USER_PROJECTS.getByName(userId).putWorkspaceLocation(workspaceId, project.id);
  if (dependencies.length > 0) {
    const related = await authority.setWorkspaceRelations(workspaceId, { dependsOn: dependencies.map(dependency => dependency.id), relatedTo: [], stackedOn: sourceWorkspace?.id ?? null });
    if (related.status === 'error') throw new Error(related.failure.message);
  }
  const operation = await authority.createOperation({ projectId: project.id, workspaceId, kind: 'workspace.create', steps: WORKSPACE_CREATE_STEPS, createdBy: 'account' });
  return provisionWorkspace(authority, env.SPACE_AUTHORITY.getByName(`${userId}:${workspaceId}`), project, code, definition, source, operation);
}

/** Resumes a failed or interrupted creation. A recorded source commit is reused, except that a workspace source is
 * read again so the retry starts from that workspace's current state; a definition written before its source
 * resolved resolves it now. */
export async function retryCloudWorkspaceCreation(env: Env, userId: string, workspaceId: string): Promise<{ workspace: CloudWorkspaceDefinition; operation: CloudProjectOperation }> {
  const { authority, definition } = await requireWorktree(env, userId, workspaceId);
  if (definition.lifecycle !== 'failed' && definition.lifecycle !== 'provisioning') {
    throw new Error(`Workspace ${definition.name} is ${definition.lifecycle}; only a failed or unfinished creation can be retried`);
  }
  const project = await requireActiveProject(authority, definition.projectId);
  const worktrees = (await authority.listWorkspaces()).filter(workspace => workspace.kind === 'worktree' && workspace.lifecycle !== 'deleting' && workspace.id !== workspaceId);
  const sourceWorkspace = findSourceWorkspace(worktrees, definition);
  const code = new ArtifactsCodeStore(env.ARTIFACTS);
  let source: ResolvedSource;
  if (definition.sourceCommit === null || sourceWorkspace) source = await resolveSource(env, userId, code, project, sourceWorkspace, definition);
  else {
    await ensureProjectCodeRepository(code, project);
    source = { sourceRef: definition.sourceRef, sourceCommit: definition.sourceCommit, repository: artifactsProjectRepository(project.id), checkpoint: null };
  }
  const provisioning = await authority.putWorkspace(revise(definition, { lifecycle: 'provisioning', sourceCommit: source.sourceCommit }));
  const operation = await authority.createOperation({ projectId: project.id, workspaceId, kind: 'workspace.create', steps: WORKSPACE_CREATE_STEPS, createdBy: 'account' });
  return provisionWorkspace(authority, env.SPACE_AUTHORITY.getByName(`${userId}:${workspaceId}`), project, code, provisioning, source, operation);
}

/** A legacy space held open by a machine is the only placement that can fence a cloud workspace lifecycle change. */
async function requireReleasedPlacement(env: Env, userId: string, workspaceId: string, expectedGeneration: number | null, absent: number | null): Promise<number> {
  const space = env.SPACE_AUTHORITY.getByName(`${userId}:${workspaceId}`);
  const placement = await space.get();
  const generation = placement?.generation ?? absent;
  if (generation !== expectedGeneration) throw new Error(`Workspace generation conflict: expected ${expectedGeneration}, actual ${generation}`);
  if (placement?.machineId && !await space.hasCloudRuntime()) throw new Error('This legacy workspace must be migrated from its machine checkout before cloud lifecycle operations are available.');
  return placement?.generation ?? 0;
}

/** Archives a workspace. The workspace object turns read-only and stops its runtime (working conversations stop,
 * caches are asked to detach) before it tells its project. */
export async function archiveCloudWorkspace(env: Env, userId: string, input: { projectId: string; spaceId: string; expectedRevision: number; expectedGeneration: number | null }): Promise<CloudWorkspaceDefinition> {
  const authority = await requireProject(env, userId, input.projectId);
  const definition = await authority.getWorkspace(input.spaceId);
  if (!definition || definition.projectId !== input.projectId || definition.kind !== 'worktree' || definition.lifecycle === 'deleting') throw new CloudLifecycleTargetMissing('workspace', input.spaceId);
  if (definition.revision !== input.expectedRevision) throw new Error(`Workspace revision conflict: expected ${input.expectedRevision}, actual ${definition.revision}`);
  if (definition.lifecycle === 'archived') return definition;
  if (definition.lifecycle !== 'active' && definition.lifecycle !== 'failed') throw new Error(`Workspace ${definition.name} is ${definition.lifecycle}; retry or delete its creation instead`);
  await requireReleasedPlacement(env, userId, definition.id, input.expectedGeneration, null);
  return runOperation(authority, { projectId: input.projectId, workspaceId: definition.id, kind: 'workspace.archive', labels: ['Stop workspace runtime and archive workspace'] },
    () => env.SPACE_AUTHORITY.getByName(`${userId}:${definition.id}`).archiveWorkspace(definition));
}

/** Returns an archived workspace to active use: the workspace object accepts writes again, then tells its project. Its
 * runtime reopens on first use. */
export async function restoreCloudWorkspace(env: Env, userId: string, input: { spaceId: string; expectedGeneration: number }): Promise<{ definition: CloudWorkspaceDefinition; generation: number }> {
  const { authority, definition } = await requireWorktree(env, userId, input.spaceId);
  const generation = await requireReleasedPlacement(env, userId, definition.id, input.expectedGeneration, 0);
  if (definition.lifecycle === 'active') return { definition, generation };
  if (definition.lifecycle !== 'archived') throw new Error(`Workspace ${definition.name} is ${definition.lifecycle}; only an archived workspace can be restored`);
  const restored = await runOperation(authority, { projectId: definition.projectId, workspaceId: definition.id, kind: 'workspace.restore', labels: ['Restore workspace'] },
    () => env.SPACE_AUTHORITY.getByName(`${userId}:${definition.id}`).restoreWorkspace(definition));
  return { definition: restored, generation };
}

/** Permanently deletes a workspace in any state: its runtime state, caches, repository and definition. The workspace
 * object stops its runtime and erases its state before its project records it deleting. */
export async function deleteCloudWorkspace(env: Env, userId: string, workspaceId: string): Promise<boolean> {
  const { authority, definition } = await requireWorktree(env, userId, workspaceId);
  return runOperation(authority, { projectId: definition.projectId, workspaceId, kind: 'workspace.delete', labels: ['Erase workspace runtime', 'Delete workspace repository', 'Delete workspace authority'] }, async advance => {
    const deleting = await env.SPACE_AUTHORITY.getByName(`${userId}:${workspaceId}`).deleteWorkspace(definition);
    await advance();
    await new ArtifactsCodeStore(env.ARTIFACTS).deleteRepository(artifactsWorkspaceRepository(workspaceId));
    await advance();
    const removed = await authority.removeWorkspace(workspaceId, deleting.revision);
    await env.USER_PROJECTS.getByName(userId).removeWorkspaceLocation(workspaceId);
    return removed;
  });
}

/** Archives a project: every workspace object turns read-only and stops its runtime, its caches asked to detach; workspace
 * lifecycles are kept. Each workspace is asked from here, never by the project authority. */
export async function archiveCloudProject(env: Env, userId: string, projectId: string, expectedRevision: number): Promise<CloudProjectSummary> {
  const authority = await requireProject(env, userId, projectId);
  const workspaces = (await authority.listWorkspaces()).filter(workspace => workspace.lifecycle !== 'deleting');
  return runOperation(authority, { projectId, workspaceId: null, kind: 'project.archive', labels: ['Stop workspace runtimes', 'Archive project'] }, async advance => {
    // The authority refuses the built-in GitSpace project and a stale revision before any workspace changes.
    const archiving = await authority.setProjectLifecycle(expectedRevision, 'archiving');
    for (const workspace of workspaces) await env.SPACE_AUTHORITY.getByName(`${userId}:${workspace.id}`).applyProjectLifecycle({ projectId, workspaceId: workspace.id }, { lifecycle: 'archived', revision: archiving.revision });
    await advance();
    return env.USER_PROJECTS.getByName(userId).put(await authority.setProjectLifecycle(archiving.revision, 'archived'));
  });
}

/** Restores an archived project: every workspace object accepts writes again before the project turns active, so an
 * interrupted restore stays `restoring` and is retried. */
export async function restoreCloudProject(env: Env, userId: string, projectId: string, expectedRevision: number): Promise<CloudProjectSummary> {
  const authority = await requireProject(env, userId, projectId);
  const project = await authority.getProject();
  if (project?.lifecycle !== 'archived' && project?.lifecycle !== 'restoring') throw new Error(`Project ${projectId} is ${project?.lifecycle ?? 'unavailable'}; only an archived project can be restored`);
  return runOperation(authority, { projectId, workspaceId: null, kind: 'project.restore', labels: ['Restore workspaces', 'Restore project'] }, async advance => {
    const restoring = await authority.setProjectLifecycle(expectedRevision, 'restoring');
    for (const workspace of await authority.listWorkspaces()) {
      if (workspace.lifecycle !== 'deleting') await env.SPACE_AUTHORITY.getByName(`${userId}:${workspace.id}`).applyProjectLifecycle({ projectId, workspaceId: workspace.id }, { lifecycle: 'active', revision: restoring.revision });
    }
    await advance();
    return env.USER_PROJECTS.getByName(userId).put(await authority.setProjectLifecycle(restoring.revision, 'active'));
  });
}

/** Existing workspaces keep their branches. The base checkout changes only when clean and idle;
 * its authority owns serialization and recovery across refs, checkpoint and project metadata. */
export async function setCloudProjectBaseBranch(env: Env, userId: string, projectId: string, expectedRevision: number, baseBranch: string): Promise<CloudProjectSummary> {
  const authority = await requireProject(env, userId, projectId);
  if (!isSupportedBranchName(baseBranch)) throw new Error(`${baseBranch} is not a valid branch name`);
  return runOperation(authority, { projectId, workspaceId: null, kind: 'project.setBaseBranch', labels: ['Switch clean base checkout and project branch'] },
    () => env.SPACE_AUTHORITY.getByName(`${userId}:${projectId}`).runtimeSetBaseBranch({ projectId, workspaceId: projectId }, expectedRevision, baseBranch));
}

/** Permanently deletes a project in any state with every workspace's runtime state and repository, then its directory entry. */
export async function deleteCloudProject(env: Env, userId: string, projectId: string, expectedRevision: number): Promise<void> {
  const authority = await requireProject(env, userId, projectId);
  const project = await authority.getProject();
  if (!project) throw new CloudLifecycleTargetMissing('project', projectId);
  const workspaces = await authority.listWorkspaces();
  const code = new ArtifactsCodeStore(env.ARTIFACTS);
  // Each workspace object marks itself unavailable and erases its runtime before the authority tombstone removes its definition.
  for (const workspace of workspaces) {
    await env.SPACE_AUTHORITY.getByName(`${userId}:${workspace.id}`).runtimeErase({ projectId, workspaceId: workspace.id });
    await code.deleteRepository(artifactsWorkspaceRepository(workspace.id));
  }
  await authority.deleteProject(expectedRevision);
  await code.deleteRepository(artifactsProjectRepository(projectId));
  await env.USER_PROJECTS.getByName(userId).remove(projectId);
}

/** Moves a workspace's phase within the ceiling its dependencies set: the workspace object applies it, then its
 * project records it. */
export async function setCloudWorkspacePhase(env: Env, userId: string, identity: RuntimeIdentity, phase: WorkspacePhase): Promise<CloudWorkspaceDefinition> {
  return env.SPACE_AUTHORITY.getByName(`${userId}:${identity.workspaceId}`).setWorkspacePhase(identity, phase);
}

/** The agent's `space_workspace` changes. `create` adds a workspace to the agent's project with its first instruction
 * records; the others act on `workspaceId`, or the agent's own workspace, within the agent's project. */
export async function changeAgentWorkspace(env: Env, identity: RuntimeIdentity, request: z.infer<typeof RuntimeWorkspaceMutationArgumentsSchema>): Promise<unknown> {
  const userId = env.ACCOUNT_ID;
  const authority = env.PROJECT_AUTHORITY.getByName(`${userId}:${identity.projectId}`);
  if (request.method === 'create') {
    const { method: _method, workspaceId: _workspaceId, on: _on, goal, workflow, rubric, ...workspace } = request;
    const created = await createCloudWorkspace(env, userId, { ...workspace, projectId: identity.projectId });
    const owned = { projectId: identity.projectId, spaceId: created.workspace.id };
    const context = env.SPACE_CONTEXT.getByName(JSON.stringify([userId, owned.projectId, owned.spaceId]));
    const initialized: string[] = [];
    let initializing = 'goal';
    const publish = async (entity: string, value: { id: string; revision: number }) => {
      await authority.appendEvent({ scope: 'workspace', entity, entityId: value.id, revision: value.revision, operation: 'updated', payload: { spaceId: owned.spaceId } });
      initialized.push(entity);
    };
    try {
      await context.bootstrap(owned);
      if (goal) await publish('goal', await context.putGoal({ ...owned, expectedRevision: 0, goal }));
      initializing = 'workflow';
      if (workflow) await publish('workflow', await context.putWorkflow({ ...owned, expectedRevision: 0, workflow }));
      initializing = 'rubric';
      if (rubric) await publish('rubric', await context.putRubric({ ...owned, expectedRevision: 0, rubric }));
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
