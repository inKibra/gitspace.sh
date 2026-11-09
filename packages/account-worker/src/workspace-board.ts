import type { CloudWorkspaceDefinition } from '@gitspace/protocol';
import type { WorkspaceBoardRow, WorkspaceJournalLine } from '@gitspace/protocol-runtime';

/** The project's workspaces with their board rows, from four stored sources read once each: the project's definitions,
 * the account's status rows (each with its main agent's latest message) and journal rows, and the project's
 * pull-request links. No workspace object is read or woken. A failed read of definitions or statuses fails the whole
 * call with its reason; journal entries and pull-request numbers are only extra, so a failed read of either (an object
 * still on an earlier release) leaves them out and is logged. */
export async function readProjectWorkspaces(env: Env, projectId: string): Promise<Array<{ definition: CloudWorkspaceDefinition; board: WorkspaceBoardRow }>> {
  const index = env.USER_PROJECTS.getByName(env.ACCOUNT_ID);
  const optional = <T>(source: string, fallback: T) => (error: unknown): T => {
    console.warn(JSON.stringify({ event: 'workspace_board_source_failed', projectId, source, error: error instanceof Error ? error.message : String(error) }));
    return fallback;
  };
  const [definitions, statuses, journals, links] = await Promise.all([
    env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`).listWorkspaces(),
    index.projectWorkspaceStatuses(projectId),
    index.projectWorkspaceJournals(projectId).catch(optional<Record<string, WorkspaceJournalLine[]>>('journals', {})),
    env.PROJECT_AUTOMATIONS.getByName(`${env.ACCOUNT_ID}:${projectId}`).pullRequestLinks(projectId).catch(optional('pull requests', [])),
  ]);
  return definitions.map(definition => {
    const stored = statuses[definition.id];
    return { definition, board: {
      workspaceId: definition.id, name: definition.name, phase: definition.phase ?? null, lifecycle: definition.lifecycle,
      status: stored?.status ?? null, waitingOn: stored?.waitingOn ?? null, since: stored?.since ?? null,
      pullRequests: links.filter(link => link.workspaceId === definition.id).map(link => ({ number: link.number, state: link.state?.state ?? null, checks: link.state?.checks ?? null })),
      lastReply: stored?.lastReply ?? null, journal: journals[definition.id] ?? [],
    } };
  });
}
