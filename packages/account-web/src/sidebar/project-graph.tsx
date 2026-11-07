import type { StackStatus } from '@gitspace/protocol';
import { accountLiveKey } from '@gitspace/protocol/live-notice';
import { useResultQuery } from 'result-rpc/react';
import { createContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLiveChanges } from '../live-notices.js';
import { rpcClient } from '../rpc-client.js';
import { rpcErrorMessage } from '../rpc-error-message.js';
import { useEventRefresh, useProjectChanges } from '../SynchronizationProvider.js';
import { useRetainedQueryValue } from '../useRetainedRead.js';

/** A pull request linked to a workspace: the one its branch opened, or one a person or agent linked. */
export interface LinkedPullRequest { number: number; title: string; url: string | null }

/** What the sidebar and the workspace header know of a project beyond its directory: each workspace's relations and the
 * pull request linked to it. */
export interface ProjectGraph {
  baseBranch: string;
  relations: Readonly<Record<string, { dependsOn: readonly string[]; stackedOn: string | null }>>;
  pullRequests: Readonly<Record<string, LinkedPullRequest>>;
}

/** Project graphs by project id; empty outside the account frame. */
export const ProjectGraphsContext = createContext<Readonly<Record<string, ProjectGraph>>>({});

/** Reads one project's relations and links, again whenever the project or its automations change; renders nothing. */
function ProjectGraphReader({ projectId, onRead }: { projectId: string; onRead(projectId: string, graph: ProjectGraph): void }) {
  const view = useResultQuery(rpcClient.space.view, { projectId, workspaceId: null });
  const automations = useResultQuery(rpcClient.automations.list, { projectId });
  useEventRefresh(useProjectChanges(projectId), () => view.refetch());
  useEventRefresh(useLiveChanges(accountLiveKey('automations')), () => automations.refetch());
  const viewValue = useRetainedQueryValue(view, projectId);
  const links = useRetainedQueryValue(automations, projectId)?.links;
  const report = useRef(onRead);
  report.current = onRead;
  const graph = useMemo((): ProjectGraph | null => {
    if (!viewValue) return null;
    const pullRequests: Record<string, LinkedPullRequest> = {};
    // The newest link of a workspace wins.
    for (const link of [...links ?? []].sort((a, b) => a.linkedAt.getTime() - b.linkedAt.getTime())) {
      if (link.subject.kind === 'pullRequest' && link.subject.number !== null) pullRequests[link.workspaceId] = { number: link.subject.number, title: link.subject.title, url: link.subject.url };
    }
    return {
      baseBranch: viewValue.project.baseBranch,
      relations: Object.fromEntries(viewValue.workspaces.map(workspace => [workspace.id, { dependsOn: workspace.relations.dependsOn, stackedOn: workspace.relations.stackedOn }])),
      pullRequests,
    };
  }, [viewValue, links]);
  useEffect(() => { if (graph) report.current(projectId, graph); }, [projectId, graph]);
  return null;
}

/** Keeps a graph for each listed project, read in the background by `readers`, which the caller renders. */
export function useProjectGraphs(projectIds: readonly string[]): { graphs: Readonly<Record<string, ProjectGraph>>; readers: ReactNode } {
  const [graphs, setGraphs] = useState<Readonly<Record<string, ProjectGraph>>>({});
  const readers = projectIds.map(projectId => <ProjectGraphReader key={projectId} projectId={projectId} onRead={(id, graph) => setGraphs(current => ({ ...current, [id]: graph }))} />);
  return { graphs, readers };
}

/** The git position of each listed stacked workspace against its parent: read when the list changes and again on each
 * `refresh` count (coalesced: one read at a time). The last positions stay while a read runs; a failed read keeps its
 * message until the next one succeeds. */
export function useStackStatuses(workspaceIds: readonly string[], refresh: number | null): { statuses: ReadonlyMap<string, StackStatus>; error: string | null; retry(): void } {
  const key = workspaceIds.join('\n');
  const [statuses, setStatuses] = useState<ReadonlyMap<string, StackStatus>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(key);
  latest.current = key;
  const read = useCallback(async () => {
    if (!key) return;
    try {
      const positions = await Promise.all(key.split('\n').map(async (workspaceId): Promise<[string, StackStatus]> => {
        const result = await rpcClient.workspace.stackStatus({ workspaceId });
        if (result.status === 'error') throw result.error;
        return [workspaceId, result.value];
      }));
      if (latest.current !== key) return;
      setStatuses(new Map(positions));
      setError(null);
    } catch (failure) {
      if (latest.current === key) setError(rpcErrorMessage(failure, 'workspace.stackStatus'));
    }
  }, [key]);
  useEffect(() => { void read(); }, [read]);
  useEventRefresh(refresh, read);
  return { statuses, error, retry: () => void read() };
}
