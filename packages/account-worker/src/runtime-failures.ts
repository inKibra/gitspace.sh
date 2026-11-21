import { acrossRelease } from './release-worker.js';
import type { RuntimeIdentity } from './runtime-services.js';

/**
 * Posts the failures GitSpace's runtime records in one workspace to its project's Chatter, as GitSpace tooling posts
 * under fixed topics of their source and error (`ProjectChatterDO.runtimeFailure`, docs/CHATTER-DESIGN.md §5.1). The
 * workspace's name is read once per reporter. A post that cannot be made is logged, never thrown: a failure report
 * must not fail what reported it.
 */
export function runtimeFailureReporter(env: Env, identity: RuntimeIdentity): (source: string, error: unknown) => Promise<void> {
  // Stubs per call: one that saw an error, such as an object resetting for a release, stays broken.
  const authority = () => env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${identity.projectId}`);
  let name: Promise<string> | undefined;
  const baseWorkspaceId: string = identity.projectId;
  return async (source, error) => {
    const message = error instanceof Error ? error.message : String(error);
    try {
      name ??= (identity.workspaceId === baseWorkspaceId
        ? acrossRelease(() => authority().getProject()).then(project => project?.name ?? identity.workspaceId)
        : acrossRelease(() => authority().getWorkspace(identity.workspaceId)).then(workspace => workspace?.name ?? identity.workspaceId))
        .catch(() => { name = undefined; return identity.workspaceId; });
      const workspace = { id: identity.workspaceId, name: await name };
      await acrossRelease(async () => { await env.PROJECT_CHATTER.getByName(`${env.ACCOUNT_ID}:${identity.projectId}`).runtimeFailure({ projectId: identity.projectId, workspace, source, message }); });
    } catch (failure) {
      console.error(JSON.stringify({ event: 'runtime_failure_unposted', workspaceId: identity.workspaceId, source, message, error: failure instanceof Error ? failure.message : String(failure) }));
    }
  };
}
