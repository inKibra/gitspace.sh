import type { RuntimeSnapshot } from '@gitspace/protocol-runtime';

/** Base spaces and branch workspaces alike are authorized by their own workspace object from its local metadata;
 * the project authority is not consulted. */
export async function requireWorkspaceAccess(
  env: Env, userId: string, identity: Pick<RuntimeSnapshot, 'projectId' | 'workspaceId'>, write: boolean,
) {
  const authority = env.SPACE_AUTHORITY.getByName(`${userId}:${identity.workspaceId}`);
  return { authority, workspace: await authority.runtimeAccess(identity, write) };
}
