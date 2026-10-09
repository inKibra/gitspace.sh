import { cloudResourceId, normalizeRemoteRepositoryUrl, type CloudProjectOperation, type CloudProjectSummary, type CloudWorkspaceDefinition } from '@gitspace/protocol';
import type { SpaceView } from '@gitspace/protocol/rpc-contract';
import { deriveWorkspaceStatusSummary, emptyRelations, emptyStack, validateStack } from '@gitspace/protocol-workspace';

/** A public remote names its default branch within this window, or the import asks for the branch. */
const DEFAULT_BRANCH_PROBE_MS = 15_000;
/** The default branch is advertised on the first ref line; the rest of the advertisement is never read. */
const REF_ADVERTISEMENT_LIMIT = 64 * 1024;

/**
 * The default branch a public smart-HTTP remote advertises (`symref=HEAD:refs/heads/<branch>`), or null when the
 * remote is private, unreachable, or an SSH host other than GitHub.
 */
export async function remoteDefaultBranch(repository: string): Promise<string | null> {
  const github = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/iu.exec(repository);
  const base = github ? `https://github.com/${github[1]}.git` : /^https?:\/\//iu.test(repository) ? repository.replace(/\/+$/u, '') : null;
  if (!base) return null;
  const response = await fetch(`${base}/info/refs?service=git-upload-pack`, { signal: AbortSignal.timeout(DEFAULT_BRANCH_PROBE_MS) }).catch(() => null);
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
  const baseBranch = input.baseBranch?.trim() || (repositoryReference ? await remoteDefaultBranch(repositoryReference) : 'main');
  if (!baseBranch) throw new Error("GitSpace can't read this repository's default branch, so it may be private. Enter its base branch to import it.");
  if (baseBranch.startsWith('-') || /[\s\u0000-\u001f\u007f]/u.test(baseBranch)) throw new Error('Enter a valid base branch name.');
  const projectId = cloudResourceId(name);
  const index = env.USER_PROJECTS.getByName(userId);
  const authority = env.PROJECT_AUTHORITY.getByName(`${userId}:${projectId}`);
  const provisioning = await authority.bootstrap({ id: projectId, name, repositoryReference, baseBranch, createdBy: 'account' });
  if (provisioning.lifecycle !== 'provisioning' || provisioning.revision !== 1) throw new Error(`Project ${projectId} already exists`);
  try {
    const created = await authority.createOperation({
      projectId, workspaceId: null, kind: repositoryReference ? 'project.import' : 'project.create', targetMachines: [],
      steps: [{ id: 'project', label: repositoryReference ? 'Record repository' : 'Create project' }], createdBy: 'account',
    });
    await authority.ensureBaseWorkspace({ userId, projectId });
    await index.putWorkspaceLocation(projectId, projectId);
    const finishedAt = new Date().toISOString();
    const operation = await authority.updateOperation({
      id: created.id, expectedRevision: created.revision, state: 'succeeded', error: null,
      steps: created.steps.map(step => ({ ...step, state: 'succeeded', updatedAt: finishedAt })),
    });
    const project = await index.put(await authority.setProjectLifecycle(provisioning.revision, 'active'));
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

/** The project's workspaces, relations, and stack read from cloud state; no machine is consulted. */
export async function readCloudSpaceView(env: Env, userId: string, projectId: string): Promise<SpaceView> {
  const authority = env.PROJECT_AUTHORITY.getByName(`${userId}:${projectId}`);
  // Captured before the reads, so a client resuming from it replays any change made while they ran.
  const eventOffset = await authority.latestEventOffset();
  const [project, definitions, relations] = await Promise.all([authority.getProject(), authority.listWorkspaces(), authority.listWorkspaceRelations()]);
  if (!project || project.lifecycle === 'deleting') throw new Error(`Project ${projectId} is unavailable`);
  const live = definitions.filter(definition => definition.lifecycle !== 'deleting');
  const base = live.find(definition => definition.kind === 'base') ?? await authority.ensureBaseWorkspace({ userId, projectId });
  const worktrees = live.filter(definition => definition.kind === 'worktree');
  const placement = async (definition: CloudWorkspaceDefinition) => {
    const space = env.SPACE_AUTHORITY.getByName(`${userId}:${definition.id}`);
    const [record, status] = await Promise.all([space.get(), space.runtimeWorkspaceStatus()]);
    const possessedBy = record?.state === 'open' ? record.machineId : null;
    return {
      closedAt: definition.archivedAt ? new Date(definition.archivedAt) : null,
      possessedBy, spaceGeneration: record?.generation ?? 0,
      status: status ?? deriveWorkspaceStatusSummary({ agents: [] }),
    };
  };
  const stacks = validateStack(worktrees.map(definition => ({
    id: definition.id, name: definition.name, phase: definition.phase ?? 'plan', closedAt: definition.archivedAt, relations: relations[definition.id] ?? emptyRelations(),
  })));
  const [baseSpace, workspaces] = await Promise.all([
    placement(base),
    Promise.all(worktrees.map(async definition => {
      const state = await placement(definition);
      return {
        ...state, id: definition.id, projectId, projectName: project.name, name: definition.name, branch: definition.branch, rootPath: '',
        phase: definition.phase ?? 'plan', possessionGeneration: state.possessedBy ? state.spaceGeneration : null,
        relations: relations[definition.id] ?? emptyRelations(), stack: stacks.get(definition.id) ?? emptyStack(),
      };
    })),
  ]);
  return {
    project: { id: project.id, name: project.name, baseBranch: project.baseBranch, connected: true },
    workspaces,
    baseSpace: { ...baseSpace, id: base.id, projectId, kind: 'base', name: base.name, branch: base.branch },
    mainAgent: null, artifacts: [], eventOffset, checkpoint: null,
  };
}
