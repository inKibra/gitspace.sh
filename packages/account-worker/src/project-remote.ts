import type { CloudProjectSummary, CloudWorkspaceDefinition } from '@gitspace/protocol';
import { GitDiscoveryError, readAdvertisedRefs } from '@gitspace/runtime-workspace-do';
import { originAccess, OriginNeedsMachineError } from './origin-access.js';

/**
 * Reads the origin's branches now, as a push webhook would report them: the project's base branch and every workspace
 * branch, one the origin lacks reported as absent. A project without a remote has nothing to read. An origin only a
 * machine reads (`OriginNeedsMachineError`) is not read.
 */
export async function readOriginHeads(env: Env, project: CloudProjectSummary, workspaces: CloudWorkspaceDefinition[]): Promise<Array<{ branch: string; head: string | null }>> {
  if (project.repositoryReference === null) return [];
  const access = await originAccess(env, project.repositoryReference);
  // Only a machine holding the account SSH key reaches an SSH origin off GitHub.
  if (!/^https?:\/\//iu.test(access.remote)) throw new OriginNeedsMachineError(project.repositoryReference);
  const credentials = access.kind === 'github-app' ? await access.auth('read') : null;
  const refs = await readAdvertisedRefs({ remote: access.remote, auth: credentials, refPrefix: 'refs/heads/' }).catch((error: unknown) => {
    if (error instanceof GitDiscoveryError && error.needsCredentials && access.kind === 'public') throw new OriginNeedsMachineError(project.repositoryReference ?? access.remote);
    throw error;
  });
  return projectBranchHeads(project, workspaces, refs);
}

/** The heads of the project's base branch and its workspaces' branches among an origin's `refs/heads/*`. */
function projectBranchHeads(project: CloudProjectSummary, workspaces: CloudWorkspaceDefinition[], refs: ReadonlyMap<string, string>): Array<{ branch: string; head: string | null }> {
  const branches = new Set([project.baseBranch, ...workspaces.filter((workspace) => workspace.lifecycle !== 'deleting').map((workspace) => workspace.branch)]);
  return [...branches].map((branch) => ({ branch, head: refs.get(`refs/heads/${branch}`) ?? null }));
}

/** Check origin: the origin's branches, read now and recorded on the project. `branches` are every branch of the
 * origin as a machine read them for an origin only it reads (`project.remote.branches`); the cloud then reads none. */
export async function refreshProjectRemote(env: Env, userId: string, projectId: string, branches?: ReadonlyArray<{ branch: string; commit: string }>): Promise<void> {
  const authority = env.PROJECT_AUTHORITY.getByName(`${userId}:${projectId}`);
  const [project, workspaces] = await Promise.all([authority.getProject(), authority.listWorkspaces()]);
  if (!project) throw new Error(`Project ${projectId} is unavailable`);
  const heads = branches === undefined
    ? await readOriginHeads(env, project, workspaces)
    : project.repositoryReference === null ? [] : projectBranchHeads(project, workspaces, new Map(branches.map(({ branch, commit }) => [`refs/heads/${branch}`, commit])));
  if (heads.length > 0) await authority.recordRemoteHeads(heads);
}
