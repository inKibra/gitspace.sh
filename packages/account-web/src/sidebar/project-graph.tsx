import type { StackStatus } from '@gitspace/protocol';
import type { AccountDirectorySnapshot } from '@gitspace/protocol/account-directory';
import type { PullRequestState } from '@gitspace/protocol/automations-contract';
import { accountLiveKey } from '@gitspace/protocol/live-notice';
import { emptyRelations } from '@gitspace/protocol-workspace';
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

/** A workspace's relations as the sidebar reads them: what it is stacked on (merge order and branch content), what it
 * waits on and is related to (planning labels), all from the account directory; and from the project view, its branch's
 * position against its parent (null when unstacked or not yet read) and, when it is already in a later phase than its
 * parent (only possible from before the phase rule), what the project view says of that. */
export interface GraphRelations {
  dependsOn: readonly string[];
  relatedTo: readonly string[];
  stackedOn: string | null;
  position: StackStatus | null;
  aheadOfParent: string | null;
}

/** What the sidebar and the workspace header know of a project beyond its directory: each workspace's relations and the
 * pull requests linked to it, open and draft ones first, then merged and closed ones, each group newest link first (null
 * until the project's links are read). */
export interface ProjectGraph {
  baseBranch: string;
  relations: Readonly<Record<string, GraphRelations>>;
  pullRequests: Readonly<Record<string, readonly LinkedPullRequest[]>> | null;
}

/** Project graphs by project id; empty outside the account frame. */
export const ProjectGraphsContext = createContext<Readonly<Record<string, ProjectGraph>>>({});

/** One project's slow reads: what the project view says of each workspace (its relations, and its branch's position
 * and phase finding against the parent it was measured against), and the links; each null until read. */
interface ProjectReading {
  stack: Readonly<Record<string, GraphRelations>> | null;
  pullRequests: Readonly<Record<string, readonly LinkedPullRequest[]>> | null;
}

/** Reads one project's stack positions and links, again whenever the project or its automations change, and when
 * `refresh` moves (then `onRefreshed`); renders nothing. */
function ProjectGraphReader({ projectId, refresh, onRead, onRefreshed }: { projectId: string; refresh: number; onRead(projectId: string, reading: ProjectReading): void; onRefreshed(projectId: string): void }) {
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
  const stack = useMemo(() => viewValue ? Object.fromEntries(viewValue.workspaces.map((workspace): [string, GraphRelations] => [workspace.id, {
    ...workspace.relations, position: workspace.stack.position, aheadOfParent: workspace.stack.findings.find(finding => finding.code === 'ahead-of-parent')?.message ?? null,
  }])) : null, [viewValue]);
  const pullRequests = useMemo(() => {
    if (!links) return null;
    const linked: Record<string, LinkedPullRequest[]> = {};
    const ordered = [...links].sort((a, b) => Number(Object.hasOwn(DONE_STATES, a.pullRequest?.state ?? '')) - Number(Object.hasOwn(DONE_STATES, b.pullRequest?.state ?? '')) || b.linkedAt.getTime() - a.linkedAt.getTime());
    for (const link of ordered) {
      if (link.subject.kind !== 'pullRequest' || link.subject.number === null) continue;
      (linked[link.workspaceId] ??= []).push({ number: link.subject.number, title: link.subject.title, url: link.subject.url, state: link.pullRequest?.state ?? null, checks: link.pullRequest?.checks ?? null });
    }
    return linked;
  }, [links]);
  useEffect(() => { report.current(projectId, { stack, pullRequests }); }, [projectId, stack, pullRequests]);
  return null;
}

/** Keeps a graph for each listed project: its workspaces' relations from the account directory at once, and their stack
 * positions and links once `readers`, which the caller renders, read them in the background. Where the directory does
 * not know a workspace's relations yet (a copy saved before it carried them, or an entry its project has not been read
 * again for), the project view's are used once read. A position the project view measured against another parent than
 * the graph's is not shown. `refresh` reads one project's view again now, settling once the read ended (at once for a
 * project not listed). */
export function useProjectGraphs(projects: readonly { id: string; baseBranch: string }[], workspaces: readonly Pick<AccountDirectorySnapshot['workspaces'][number], 'id' | 'projectId' | 'kind' | 'lifecycle' | 'relations'>[]): { graphs: Readonly<Record<string, ProjectGraph>>; readers: ReactNode; refresh(projectId: string): Promise<void> } {
  const [readings, setReadings] = useState<Readonly<Record<string, ProjectReading>>>({});
  const [requests, setRequests] = useState<Readonly<Record<string, number>>>({});
  const waiting = useRef(new Map<string, Array<() => void>>());
  const graphs = useMemo(() => {
    const relations: Record<string, Record<string, GraphRelations>> = {};
    for (const workspace of workspaces) {
      if (workspace.kind !== 'worktree' || workspace.lifecycle === 'deleting') continue;
      const viewed = readings[workspace.projectId]?.stack?.[workspace.id];
      const listed = workspace.relations ?? viewed ?? emptyRelations();
      const measured = viewed?.stackedOn === listed.stackedOn ? viewed : null;
      (relations[workspace.projectId] ??= {})[workspace.id] = { dependsOn: listed.dependsOn, relatedTo: listed.relatedTo, stackedOn: listed.stackedOn, position: measured?.position ?? null, aheadOfParent: measured?.aheadOfParent ?? null };
    }
    return Object.fromEntries(projects.map((project): [string, ProjectGraph] => [project.id, { baseBranch: project.baseBranch, relations: relations[project.id] ?? {}, pullRequests: readings[project.id]?.pullRequests ?? null }]));
  }, [projects, workspaces, readings]);
  const settle = (projectId: string) => {
    for (const resolve of waiting.current.get(projectId) ?? []) resolve();
    waiting.current.delete(projectId);
  };
  const refresh = (projectId: string): Promise<void> => {
    if (!projects.some((project) => project.id === projectId)) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    waiting.current.set(projectId, [...waiting.current.get(projectId) ?? [], resolve]);
    setRequests(current => ({ ...current, [projectId]: (current[projectId] ?? 0) + 1 }));
    return promise;
  };
  const readers = projects.map(({ id }) => <ProjectGraphReader key={id} projectId={id} refresh={requests[id] ?? 0} onRefreshed={settle}
    onRead={(projectId, reading) => setReadings(current => ({ ...current, [projectId]: reading }))} />);
  return { graphs, readers, refresh };
}
