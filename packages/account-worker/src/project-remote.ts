import { GitDiscoveryError, readAdvertisedRefs } from '@gitspace/runtime-workspace-do';
import { originAccess } from './origin-access.js';

/**
 * Reads the origin's branches now, as a push webhook would report them: the project's base branch and every workspace
 * branch, one the origin lacks recorded as absent. A project without a remote has nothing to read.
 */
export async function refreshProjectRemote(env: Env, userId: string, projectId: string): Promise<void> {
  const authority = env.PROJECT_AUTHORITY.getByName(`${userId}:${projectId}`);
  const [project, workspaces] = await Promise.all([authority.getProject(), authority.listWorkspaces()]);
  if (!project) throw new Error(`Project ${projectId} is unavailable`);
  if (project.repositoryReference === null) return;
  const access = await originAccess(env, project.repositoryReference);
  // Only a machine holding the account SSH key reaches an SSH origin off GitHub.
  if (!/^https?:\/\//iu.test(access.remote)) throw new Error(`GitSpace reads origins over HTTPS; ${project.repositoryReference} is reachable only from a machine with the account SSH key`);
  const credentials = access.kind === 'github-app' ? await access.auth('read') : null;
  const refs = await readAdvertisedRefs({ remote: access.remote, auth: credentials, refPrefix: 'refs/heads/' }).catch((error: unknown) => {
    if (error instanceof GitDiscoveryError && error.needsCredentials && access.kind === 'public') {
      throw new Error(`GitSpace can't read ${project.repositoryReference} without credentials: install the account's GitHub App on it to track it from the cloud`);
    }
    throw error;
  });
  const branches = new Set([project.baseBranch, ...workspaces.filter((workspace) => workspace.lifecycle !== 'deleting').map((workspace) => workspace.branch)]);
  await authority.recordRemoteHeads([...branches].map((branch) => ({ branch, head: refs.get(`refs/heads/${branch}`) ?? null })));
}
