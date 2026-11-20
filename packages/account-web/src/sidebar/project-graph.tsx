import type { StackStatus } from '@gitspace/protocol';
import type { PullRequestState } from '@gitspace/protocol/automations-contract';
import { accountLiveKey } from '@gitspace/protocol/live-notice';
import { useResultQuery } from 'result-rpc/react';
import { createContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLiveChanges } from '../live-notices.js';
import { rpcClient } from '../rpc-client.js';
import { useEventRefresh, useProjectChanges } from '../SynchronizationProvider.js';
import { useRetainedQueryValue } from '../useRetainedRead.js';

/** Pull request states that are over: their chips come after the open and draft ones. */
const DONE_STATES: Record<string, true> = { merged: true, closed: true };

/** A pull request linked to a workspace (the one its branch opened, or one a person or agent linked), with its state
 * and checks as last read from GitHub; null until first read. */
export interface LinkedPullRequest {
  number: number;
  title: string;
  url: string | null;
  state: PullRequestState['state'] | null;
  checks: PullRequestState['checks'] | null;
}

/** A workspace's relations as the sidebar reads them from the project view: what it is stacked on (merge order and
 * branch content), what it waits on and is related to (planning labels), its branch's position against its parent
 * (null when unstacked or unread), and, when it is already in a later phase than its parent (only possible from before
 * the phase rule), what the project view says of that. */
export interface GraphRelations {
  dependsOn: readonly string[];
  relatedTo: readonly string[];
  stackedOn: string | null;
  position: StackStatus | null;
  aheadOfParent: string | null;
}

/** What the sidebar and the workspace header know of a project beyond its directory: each workspace's relations and the
 * pull requests linked to it, open and draft ones first, then merged and closed ones, each group newest link first. */
export interface ProjectGraph {
  baseBranch: string;
  relations: Readonly<Record<string, GraphRelations>>;
  pullRequests: Readonly<Record<string, readonly LinkedPullRequest[]>>;
}

/** Project graphs by project id; empty outside the account frame. */
export const ProjectGraphsContext = createContext<Readonly<Record<string, ProjectGraph>>>({});

/** Reads one project's relations and links, again whenever the project or its automations change, and when `refresh`
 * moves (then `onRefreshed`); renders nothing. */
function ProjectGraphReader({ projectId, refresh, onRead, onRefreshed }: { projectId: string; refresh: number; onRead(projectId: string, graph: ProjectGraph): void; onRefreshed(projectId: string): void }) {
  const view = useResultQuery(rpcClient.space.view, { projectId, workspaceId: null });
  const automations = useResultQuery(rpcClient.automations.list, { projectId });
  useEventRefresh(useProjectChanges(projectId), () => view.refetch());
  useEventRefresh(useLiveChanges(accountLiveKey('automations')), () => automations.refetch());
  const viewValue = useRetainedQueryValue(view, projectId);
  const links = useRetainedQueryValue(automations, projectId)?.links;
  const report = useRef(onRead);
  report.current = onRead;
  useEventRefresh(refresh === 0 ? null : refresh, async () => {
    try { await view.refetch(); } finally { onRefreshed(projectId); }
  });
  const graph = useMemo((): ProjectGraph | null => {
    if (!viewValue) return null;
    const pullRequests: Record<string, LinkedPullRequest[]> = {};
    const ordered = [...links ?? []].sort((a, b) => Number(Object.hasOwn(DONE_STATES, a.pullRequest?.state ?? '')) - Number(Object.hasOwn(DONE_STATES, b.pullRequest?.state ?? '')) || b.linkedAt.getTime() - a.linkedAt.getTime());
    for (const link of ordered) {
      if (link.subject.kind !== 'pullRequest' || link.subject.number === null) continue;
      (pullRequests[link.workspaceId] ??= []).push({ number: link.subject.number, title: link.subject.title, url: link.subject.url, state: link.pullRequest?.state ?? null, checks: link.pullRequest?.checks ?? null });
    }
    return {
      baseBranch: viewValue.project.baseBranch,
      relations: Object.fromEntries(viewValue.workspaces.map((workspace): [string, GraphRelations] => [workspace.id, {
        dependsOn: workspace.relations.dependsOn, relatedTo: workspace.relations.relatedTo, stackedOn: workspace.relations.stackedOn,
        position: workspace.stack.position, aheadOfParent: workspace.stack.findings.find(finding => finding.code === 'ahead-of-parent')?.message ?? null,
      }])),
      pullRequests,
    };
  }, [viewValue, links]);
  useEffect(() => { if (graph) report.current(projectId, graph); }, [projectId, graph]);
  return null;
}

/** Keeps a graph for each listed project, read in the background by `readers`, which the caller renders. `refresh`
 * reads one project's graph again now, settling once the read ended (at once for a project not listed). */
export function useProjectGraphs(projectIds: readonly string[]): { graphs: Readonly<Record<string, ProjectGraph>>; readers: ReactNode; refresh(projectId: string): Promise<void> } {
  const [graphs, setGraphs] = useState<Readonly<Record<string, ProjectGraph>>>({});
  const [requests, setRequests] = useState<Readonly<Record<string, number>>>({});
  const waiting = useRef(new Map<string, Array<() => void>>());
  const settle = (projectId: string) => {
    for (const resolve of waiting.current.get(projectId) ?? []) resolve();
    waiting.current.delete(projectId);
  };
  const refresh = (projectId: string): Promise<void> => {
    if (!projectIds.includes(projectId)) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    waiting.current.set(projectId, [...waiting.current.get(projectId) ?? [], resolve]);
    setRequests(current => ({ ...current, [projectId]: (current[projectId] ?? 0) + 1 }));
    return promise;
  };
  const readers = projectIds.map(projectId => <ProjectGraphReader key={projectId} projectId={projectId} refresh={requests[projectId] ?? 0} onRefreshed={settle}
    onRead={(id, graph) => setGraphs(current => ({ ...current, [id]: graph }))} />);
  return { graphs, readers, refresh };
}
