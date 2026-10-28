import { cloudResourceId, normalizeRemoteRepositoryUrl, type CloudProjectOperation, type CloudProjectSummary, type CloudWorkspaceDefinition } from '@gitspace/protocol';
import { githubRepositoryOf } from '@gitspace/protocol/github';
import type { SpaceView } from '@gitspace/protocol/rpc-contract';
import { emptyRelations, emptyStack, emptyWorkspaceStatus, validateStack, type WorkspaceStatusSummary } from '@gitspace/protocol-workspace';
import { gitAuthorizationHeaders } from '@gitspace/runtime-workspace-do';
import { originAccess } from './origin-access.js';

/** A public remote names its default branch within this window, or the import asks for the branch. */
const DEFAULT_BRANCH_PROBE_MS = 15_000;
/** The default branch is advertised on the first ref line; the rest of the advertisement is never read. */
const REF_ADVERTISEMENT_LIMIT = 64 * 1024;

/**
 * The default branch a smart-HTTP remote advertises (`symref=HEAD:refs/heads/<branch>`), or null when the remote is
 * unreadable (private and uncovered, unreachable, or an SSH host other than GitHub). Coverage is resolved before any
 * request: a repository an installation covers is asked only with its installation token, never anonymously.
 */
export async function remoteDefaultBranch(env: Env, repository: string): Promise<string | null> {
  const access = await originAccess(env, repository);
  if (!/^https?:\/\//iu.test(access.remote)) return null;
  const auth = access.kind === 'github-app' ? await access.auth('read') : null;
  const response = await fetch(`${access.remote.replace(/\/+$/u, '')}/info/refs?service=git-upload-pack`, {
    headers: gitAuthorizationHeaders(auth), signal: AbortSignal.timeout(DEFAULT_BRANCH_PROBE_MS),
    // The installation token never follows a redirect to another host.
    redirect: auth === null ? 'follow' : 'manual',
  }).catch(() => null);
  if (!response?.ok || !response.body) {
    await response?.body?.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let advertised = '';
  try {
    while (advertised.length < REF_ADVERTISEMENT_LIMIT) {
      const { done, value } = await reader.read();
      if (done) return null;
      advertised += decoder.decode(value, { stream: true });
      const branch = /symref=HEAD:refs\/heads\/([^\s\0]+)[\s\0]/u.exec(advertised)?.[1];
      if (branch) return branch;
    }
    return null;
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Creates a project entirely in the cloud: its authority, base workspace, and directory entry. No machine is involved;
 * the project repository is created (or a public remote imported) when its first workspace runtime opens, and a
 * repository Artifacts cannot import is seeded by a machine the user attaches.
 */
export async function createCloudProject(env: Env, userId: string, input: { name: string; baseBranch: string | null; repositoryUrl: string | null }): Promise<{ project: CloudProjectSummary; operation: CloudProjectOperation }> {
  const name = input.name.trim();
  if (!name || name.length > 160) throw new Error('Enter a project name of at most 160 characters.');
  const repositoryReference = input.repositoryUrl?.trim() ? normalizeRemoteRepositoryUrl(input.repositoryUrl) : null;
  const baseBranch = input.baseBranch?.trim() || (repositoryReference ? await remoteDefaultBranch(env, repositoryReference) : 'main');
  if (!baseBranch) throw new Error("GitSpace can't read this repository's default branch, so it may be private. Enter its base branch to import it.");
  if (baseBranch.startsWith('-') || /[\s\u0000-\u001f\u007f]/u.test(baseBranch)) throw new Error('Enter a valid base branch name.');
  const projectId = cloudResourceId(name);
  const index = env.USER_PROJECTS.getByName(userId);
  const authority = env.PROJECT_AUTHORITY.getByName(`${userId}:${projectId}`);
  const provisioning = await authority.bootstrap({ id: projectId, name, repositoryReference, baseBranch, createdBy: 'account' });
  if (provisioning.lifecycle !== 'provisioning' || provisioning.revision !== 1) throw new Error(`Project ${projectId} already exists`);
  try {
    const created = await authority.createOperation({
      projectId, workspaceId: null, kind: repositoryReference ? 'project.import' : 'project.create',
      steps: [{ id: 'project', label: repositoryReference ? 'Record repository' : 'Create project' }], createdBy: 'account',
    });
    const base = await authority.ensureBaseWorkspace({ userId, projectId });
    await index.putWorkspaceLocation(projectId, projectId);
    const finishedAt = new Date().toISOString();
    const operation = await authority.updateOperation({
      id: created.id, state: 'succeeded', error: null,
      steps: created.steps.map(step => ({ ...step, state: 'succeeded', updatedAt: finishedAt })),
    });
    const active = await authority.setProjectLifecycle(provisioning.revision, 'active');
    // The base workspace object starts from its definition and the active project, never reading its project to seed itself.
    await env.SPACE_AUTHORITY.getByName(`${userId}:${projectId}`).seedWorkspace(base, active);
    const project = await index.put(active);
    // A repository the GitHub App already covers gives the project its default automations now.
    if (repositoryReference && githubRepositoryOf(repositoryReference) !== null) {
      await env.GITHUB_APP.getByName(userId).provideAutomationDefaults()
        .catch((error: unknown) => console.error('Default automations were not added', { projectId, error }));
    }
    return { project, operation };
  } catch (error) {
    // A project that never became active is deleted, never left half-created in the directory.
    try {
      const current = await authority.getProject();
      if (current?.lifecycle === 'provisioning') {
        await authority.deleteProject(current.revision);
        await index.removeWorkspaceLocation(projectId);
      }
    } catch (cleanupError) {
      console.error('Cloud project creation cleanup failed', { projectId, error: cleanupError });
    }
    throw error;
  }
}

/** A read Cloudflare reports as safe to repeat (`retryable`: the object was reset, as by a storage fault) runs once more. */
async function readOnceMore<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'retryable' in error && error.retryable === true) return read();
    throw error;
  }
}

/**
 * The project's workspaces, relations, stack and statuses, from two stored sources: the project object and the account's
 * status rows (each workspace pushes its own on change). No workspace object is read, so opening a project wakes none,
 * and one workspace's failure cannot fail the view. Statuses that cannot be read are reported in `statusError`.
 */
export async function readCloudSpaceView(env: Env, userId: string, projectId: string): Promise<SpaceView> {
  const authority = env.PROJECT_AUTHORITY.getByName(`${userId}:${projectId}`);
  const [[project, definitions, relations], statusRead] = await Promise.all([
    readOnceMore(() => Promise.all([authority.getProject(), authority.listWorkspaces(), authority.listWorkspaceRelations()])),
    readOnceMore(() => env.USER_PROJECTS.getByName(userId).projectWorkspaceStatuses(projectId))
      .then(statuses => ({ statuses, error: null }), (error: unknown) => ({ statuses: Object.fromEntries<WorkspaceStatusSummary>([]), error: error instanceof Error ? error.message : String(error) })),
  ]);
  if (!project || project.lifecycle === 'deleting') throw new Error(`Project ${projectId} is unavailable`);
  const live = definitions.filter(definition => definition.lifecycle !== 'deleting');
  const base = live.find(definition => definition.kind === 'base') ?? await authority.ensureBaseWorkspace({ userId, projectId });
  const worktrees = live.filter(definition => definition.kind === 'worktree');
  const listed = (definition: CloudWorkspaceDefinition) => ({
    closedAt: definition.archivedAt ? new Date(definition.archivedAt) : null,
    status: statusRead.statuses[definition.id] ?? emptyWorkspaceStatus,
  });
  const stacks = validateStack(worktrees.map(definition => ({
    id: definition.id, name: definition.name, phase: definition.phase ?? 'plan', closedAt: definition.archivedAt, relations: relations[definition.id] ?? emptyRelations(),
  })));
  return {
    project: { id: project.id, name: project.name, baseBranch: project.baseBranch, connected: true },
    workspaces: worktrees.map(definition => ({
      ...listed(definition), id: definition.id, projectId, projectName: project.name, name: definition.name, branch: definition.branch, rootPath: '',
      phase: definition.phase ?? 'plan', relations: relations[definition.id] ?? emptyRelations(), stack: stacks.get(definition.id) ?? emptyStack(),
    })),
    baseSpace: { ...listed(base), id: base.id, projectId, kind: 'base', name: base.name, branch: base.branch },
    statusError: statusRead.error,
  };
}
