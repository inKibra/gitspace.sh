import type { CloudWorkspaceDefinition } from '@gitspace/protocol';
import type { WorkspaceBoardRow } from '@gitspace/protocol-runtime';

/** The project's workspaces with their board rows, from three stored sources read once each: the project's definitions,
 * the account's status rows and the project's pull-request links. No workspace object is read or woken. A failed read
 * fails the whole call with its reason. */
export async function readProjectWorkspaces(env: Env, projectId: string): Promise<Array<{ definition: CloudWorkspaceDefinition; board: WorkspaceBoardRow }>> {
  const [definitions, statuses, links] = await Promise.all([
    env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`).listWorkspaces(),
    env.USER_PROJECTS.getByName(env.ACCOUNT_ID).projectWorkspaceStatuses(projectId),
    env.PROJECT_AUTOMATIONS.getByName(`${env.ACCOUNT_ID}:${projectId}`).pullRequestLinks(projectId),
  ]);
  return definitions.map(definition => {
    const stored = statuses[definition.id];
    return { definition, board: {
      workspaceId: definition.id, name: definition.name, phase: definition.phase ?? null, lifecycle: definition.lifecycle,
      status: stored?.status ?? null, waitingOn: stored?.waitingOn ?? null, pullRequest: links.find(link => link.workspaceId === definition.id)?.number ?? null, since: stored?.since ?? null,
    } };
  });
}
