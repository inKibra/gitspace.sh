import type { CloudWorkspaceDefinition } from '@gitspace/protocol';
import type { WorkspaceBoardRow, WorkspaceJournalLine } from '@gitspace/protocol-runtime';
import { emptyRelations, mainQuestion, stackTree, type WorkspaceRelations } from '@gitspace/protocol-workspace';

/** The project's workspaces with their board rows and relations, from five stored sources read once each: the project's
 * definitions and relations, the account's status rows (each with its main agent's latest message) and journal rows,
 * and the project's pull-request links. No workspace object is read or woken. A failed read of definitions, relations
 * or statuses fails the whole call with its reason; journal entries and pull-request numbers are only extra, so a failed
 * read of either (an object still on an earlier release) leaves them out and is logged. In the sidebar's order: stack by
 * stack, each workspace stacked on nothing followed by its stack depth-first (`stackTree` over the open workspaces,
 * listed by kind and name), then the archived and deleting ones. */
export async function readProjectWorkspaces(env: Env, projectId: string): Promise<Array<{ definition: CloudWorkspaceDefinition; board: WorkspaceBoardRow; relations: WorkspaceRelations }>> {
  const index = env.USER_PROJECTS.getByName(env.ACCOUNT_ID);
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  const optional = <T>(source: string, fallback: T) => (error: unknown): T => {
    console.warn(JSON.stringify({ event: 'workspace_board_source_failed', projectId, source, error: error instanceof Error ? error.message : String(error) }));
    return fallback;
  };
  const [definitions, relations, statuses, journals, links] = await Promise.all([
    authority.listWorkspaces(),
    authority.listWorkspaceRelations(),
    index.projectWorkspaceStatuses(projectId),
    index.projectWorkspaceJournals(projectId).catch(optional<Record<string, WorkspaceJournalLine[]>>('journals', {})),
    env.PROJECT_AUTOMATIONS.getByName(`${env.ACCOUNT_ID}:${projectId}`).pullRequestLinks(projectId).catch(optional('pull requests', [])),
  ]);
  const entries = definitions.map(definition => {
    const stored = statuses[definition.id];
    const related = relations[definition.id] ?? emptyRelations();
    return { definition, relations: related, id: definition.id, name: definition.name, phase: definition.phase ?? null, stackedOn: related.stackedOn, board: {
      workspaceId: definition.id, name: definition.name, phase: definition.phase ?? null, lifecycle: definition.lifecycle,
      status: stored?.status ?? null, waitingOn: stored ? mainQuestion(stored.waiting) : null, since: stored?.since ?? null,
      pullRequests: links.filter(link => link.workspaceId === definition.id).map(link => ({ number: link.number, state: link.state?.state ?? null, checks: link.state?.checks ?? null })),
      lastReply: stored?.lastReply ?? null, lastReplySource: stored?.lastReplySource ?? null, journal: journals[definition.id] ?? [],
    } };
  });
  const open = entries.filter(entry => entry.definition.lifecycle !== 'archived' && entry.definition.lifecycle !== 'deleting');
  return [...stackTree(open).map(({ item }) => item), ...entries.filter(entry => !open.includes(entry))]
    .map(({ definition, board, relations: related }) => ({ definition, board, relations: related }));
}
