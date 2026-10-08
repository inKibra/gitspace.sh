import type { RuntimeSnapshot } from '@gitspace/protocol-runtime';

/** Both base spaces and branch workspaces are resolved against their project authority. */
export async function requireRuntimeIdentity(
  env: Env, userId: string, identity: Pick<RuntimeSnapshot, 'projectId' | 'workspaceId'>, write: boolean,
) {
  const projectAuthority = env.PROJECT_AUTHORITY.getByName(`${userId}:${identity.projectId}`);
  const project = await projectAuthority.getProject();
  if (!project || project.id !== identity.projectId || project.lifecycle === 'deleting') throw new Error('Runtime project is unavailable');
  const workspace = identity.workspaceId === project.id ? null
    : (await projectAuthority.listWorkspaces()).find(item => item.id === identity.workspaceId && item.projectId === project.id);
  if (workspace === undefined) throw new Error('Workspace does not belong to the requested project');
  if (workspace?.lifecycle === 'deleting') throw new Error('Runtime workspace is unavailable');
  // Opening a cloud-only project or provisioning a new one bootstraps runtime state before the project turns active.
  const writableProject = project.lifecycle === 'active' || project.lifecycle === 'cloud-only' || project.lifecycle === 'provisioning';
  if (write && (!writableProject || workspace?.lifecycle === 'archived')) throw new Error('Archived runtime state is read-only');
  return { project, workspace, projectAuthority, authority: env.SPACE_AUTHORITY.getByName(`${userId}:${identity.workspaceId}`) };
}
