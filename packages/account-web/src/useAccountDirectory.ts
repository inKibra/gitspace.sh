import type { SpacePlacementView } from '@gitspace/protocol';
import type { AccountDirectorySnapshot } from '@gitspace/protocol/account-directory';
import { createContext, useCallback, useEffect, useRef, useState } from 'react';
import type { SidebarProject, SidebarSpaceSummary, SidebarWorkspace } from './AppSidebar.js';
import type { ProjectLifecycleView } from './GitSpaceShell.js';
import { ACCOUNT_DIRECTORY_CHANGED } from './routes.js';
import { useSynchronizationOwner } from './SynchronizationProvider.js';
import { accountDirectorySource } from './account-directory-transport.js';
import type { SynchronizationSource } from './synchronization.js';
import { workspaceStatuses, type WorkspaceStatuses } from './workspace-statuses.js';

export type Directory = Record<string, Pick<SidebarProject, 'workspaces' | 'baseSummary' | 'error'>>;
export interface WorkspaceProjection {
  directory: Directory;
  acceptRuntime: (projectId: string, spaceId: string, summary: SidebarSpaceSummary) => (() => void) | undefined;
}
export const AccountDirectoryContext = createContext<{
  projects: readonly ProjectLifecycleView[];
  directory: Directory;
  loading: boolean;
  refresh: () => void;
  acceptRuntime?: WorkspaceProjection['acceptRuntime'];
} | null>(null);
/** One account projection owns workspace lifecycle; every workspace takes its status from the status rows the directory
 * socket delivers (all on open, then one per change). No workspace is read to show the sidebar. */
export function useWorkspaceProjection(projects: readonly Pick<ProjectLifecycleView, 'id' | 'lifecycle'>[], source: SynchronizationSource<AccountDirectorySnapshot> = accountDirectorySource, statuses: WorkspaceStatuses = workspaceStatuses): WorkspaceProjection {
  const owner = useSynchronizationOwner();
  const accepted = useRef<Directory>({});
  const [directory, setDirectory] = useState<Directory>(accepted.current);
  const observations = useRef(new Map<string, { revision: number; summary: SidebarSpaceSummary; active: boolean }>());
  const observationRevision = useRef(0);
  const acceptRuntime = useCallback((projectId: string, spaceId: string, summary: SidebarSpaceSummary) => {
    const authority = owner.channel('account-directory', source).snapshot();
    const placement = authority.value?.placements.find((item) => item.projectId === projectId && item.spaceId === spaceId);
    const definition = authority.value?.workspaces.find((item) => item.projectId === projectId && item.id === spaceId);
    const machine = authority.value?.machines.find((item) => item.id === placement?.holderId);
    const current = accepted.current[projectId];
    if (!current || !definition || definition.archivedAt || definition.lifecycle === 'deleting' || authority.resync || authority.transportError
      || machine?.state !== 'online' || machine.desiredState !== 'online' || !placement?.endpoint
      || placement.state !== 'open' || summary.closedAt || summary.holder.kind !== 'held'
      || summary.holder.machineId !== placement.holderId || summary.generation !== placement.generation) return;
    const key = JSON.stringify([projectId, spaceId]);
    const observation = { revision: ++observationRevision.current, summary, active: true };
    observations.current.set(key, observation);
    const previous = spaceId === projectId ? current.baseSummary : current.workspaces.find((space) => space.id === spaceId)?.summary;
    if (!previous || previous.status !== summary.status || previous.generation !== summary.generation || previous.closedAt !== summary.closedAt
      || previous.freshness !== summary.freshness || previous.detail !== summary.detail || previous.refreshing !== summary.refreshing
      || previous.creation !== summary.creation || previous.holder.kind !== 'held'
      || previous.holder.machineId !== summary.holder.machineId || previous.holder.label !== summary.holder.label) {
      accepted.current = { ...accepted.current, [projectId]: spaceId === projectId
        ? { ...current, baseSummary: summary }
        : { ...current, workspaces: current.workspaces.map((space) => space.id === spaceId ? { ...space, summary } : space) } };
      setDirectory(accepted.current);
    }
    return () => { observation.active = false; };
  }, [owner, source]);
  const scope = useRef(projects);
  scope.current = projects;
  const reconcileScope = useRef(() => {});
  const projectKey = JSON.stringify(projects.map(({ id, lifecycle }) => ({ id, lifecycle })));
  useEffect(() => {
    accepted.current = {};
    observations.current.clear();
    setDirectory(accepted.current);
    const channel = owner.channel('account-directory', source);
    // The last directory inputs each project was built from; an unchanged project is not rebuilt.
    const built = new Map<string, string>();
    let force = false;
    const reconcile = () => {
      const snapshot = channel.snapshot();
      const value = snapshot.value;
      const projectIds = new Set(value?.projects.filter((project) => project.lifecycle !== 'deleting').map((project) => project.id));
      const entries = scope.current.filter((project) => project.lifecycle !== 'deleting' && (!value || projectIds.has(project.id)));
      const ids = new Set(entries.map((project) => project.id));
      for (const id of built.keys()) if (!ids.has(id)) built.delete(id);
      for (const key of observations.current.keys()) {
        const [projectId, spaceId] = JSON.parse(key) as [string, string];
        const observation = observations.current.get(key)!;
        const placement = value?.placements.find((item) => item.projectId === projectId && item.spaceId === spaceId);
        const definition = value?.workspaces.find((item) => item.projectId === projectId && item.id === spaceId);
        if (!ids.has(projectId) || !definition || definition.archivedAt || definition.lifecycle === 'deleting' || placement?.state !== 'open'
          || placement.generation !== observation.summary.generation || observation.summary.holder.kind !== 'held'
          || placement.holderId !== observation.summary.holder.machineId) observations.current.delete(key);
      }
      if (Object.keys(accepted.current).some((id) => !ids.has(id))) {
        accepted.current = Object.fromEntries(Object.entries(accepted.current).filter(([id]) => ids.has(id)));
        setDirectory(accepted.current);
      }
      // A requested reconnect is not new authoritative state or proof of recovery.
      if (snapshot.connection === 'connecting') return;
      const directoryError = snapshot.transportError?.message ?? (snapshot.resync ? 'Directory resynchronizing' : null);
      const refreshAll = force;
      force = false;
      const machines = new Map(value?.machines.map((machine) => [machine.id, machine]));
      for (const project of entries) {
        const definitions = value?.workspaces.filter((space) => space.projectId === project.id) ?? [];
        const placementValues = value?.placements.filter((space) => space.projectId === project.id) ?? [];
        const holderIds = new Set(placementValues.map((placement) => placement.holderId));
        const key = JSON.stringify([project.lifecycle, value?.projectRevisions[project.id], definitions, placementValues,
          [...holderIds].sort().map((id) => { const machine = machines.get(id); return machine && [id, machine.label, machine.state, machine.desiredState, machine.rpcEndpoint]; }), directoryError]);
        if (built.get(project.id) === key && !refreshAll) continue;
        built.set(project.id, key);
        const prior = accepted.current[project.id];
        const placements = new Map<string, SpacePlacementView>(placementValues.map((space) => [space.spaceId, space]));
        const definitionsById = new Map(definitions.map((space) => [space.id, space]));
        const previousWorkspaces = new Map(prior?.workspaces.map((space) => [space.id, space]));
        const workspaces: SidebarWorkspace[] = value ? definitions.filter((space) => space.kind !== 'base' && space.lifecycle !== 'deleting').map((space) => ({
          id: space.id, projectId: space.projectId, name: space.name, branch: space.branch, closedAt: space.archivedAt ? new Date(space.archivedAt) : null, definition: space,
        })) : prior?.workspaces ?? [];
        const summaries = new Map<string, SidebarSpaceSummary>();
        // Every workspace's status is the row it pushed to the account; no workspace is read to show it.
        const summarize = (id: string, closedAt: Date | null, previous: SidebarSpaceSummary | undefined): SidebarSpaceSummary => {
          const status = closedAt ? undefined : statuses.get(id);
          // Cloud-only projects have canonical workspaces before their first runtime opens; neither needs a machine.
          if (project.lifecycle === 'cloud-only' || (definitionsById.get(id)?.cloudRuntime ?? previous?.holder.kind === 'cloud')) {
            return { closedAt, holder: { kind: 'cloud' }, status, freshness: status ? 'fresh' : 'unknown', refreshing: false };
          }
          const placement = placements.get(id);
          if (closedAt) return { closedAt, holder: { kind: 'released' }, generation: placement?.generation, freshness: 'fresh' };
          if (!placement) return { closedAt, holder: { kind: 'unknown' }, status, freshness: status ? 'fresh' : 'unknown', refreshing: false, detail: 'Placement unavailable' };
          const machine = machines.get(placement.holderId);
          const released = placement.state === 'closed' || (placement.holderId === 'unassigned' && placement.state !== 'opening');
          const compatible = !previous?.closedAt && previous?.holder.kind === 'held' && previous.holder.machineId === placement.holderId && previous.generation === placement.generation;
          const summary: SidebarSpaceSummary = {
            closedAt, generation: placement.generation,
            holder: released ? { kind: 'released' } : placement.holderId === 'unassigned' ? { kind: 'unknown' } : { kind: 'held', machineId: placement.holderId, label: machine?.label ?? (compatible && previous?.holder.kind === 'held' ? previous.holder.label : placement.holderId) },
            freshness: 'fresh',
          };
          if (released) return summary;
          const detail = placement.state === 'opening' ? 'Opening' : placement.state === 'closing' ? 'Closing' : placement.state !== 'open' ? 'Status unknown' : null;
          return { ...summary, status, freshness: status ? 'fresh' : 'unknown', refreshing: false, detail };
        };
        const base = definitions.find((space) => space.kind === 'base' && space.lifecycle !== 'deleting');
        if (base || (!value && prior?.baseSummary)) summaries.set(project.id, summarize(project.id, base ? base.archivedAt ? new Date(base.archivedAt) : null : prior?.baseSummary?.closedAt ?? null, prior?.baseSummary));
        for (const space of workspaces) {
          const lifecycle = space.definition?.lifecycle;
          // An unfinished or failed creation has no runtime status yet.
          if (lifecycle === 'provisioning' || lifecycle === 'failed') {
            summaries.set(space.id, { closedAt: space.closedAt, holder: { kind: 'unknown' }, freshness: 'fresh', refreshing: false, creation: lifecycle });
            continue;
          }
          summaries.set(space.id, summarize(space.id, space.closedAt, previousWorkspaces.get(space.id)?.summary));
        }
        for (const [id, summary] of summaries) {
          const observation = observations.current.get(JSON.stringify([project.id, id]));
          if (observation && summary.holder.kind === 'held' && observation.summary.holder.kind === 'held'
            && summary.holder.machineId === observation.summary.holder.machineId && summary.generation === observation.summary.generation
            && !summary.closedAt && placements.get(id)?.state === 'open') {
            // An open pane's accepted activity cannot regress to an older row.
            summaries.set(id, { ...summary, status: observation.summary.status,
              ...(directoryError || summary.detail ? {} : { freshness: observation.summary.freshness, detail: observation.summary.detail }) });
          }
        }
        accepted.current = { ...accepted.current, [project.id]: {
          baseSummary: summaries.get(project.id),
          workspaces: workspaces.map((space) => ({ ...space, summary: summaries.get(space.id) })),
          error: directoryError ? `Directory unavailable: ${directoryError}` : null,
        } };
        setDirectory(accepted.current);
      }
    };
    reconcileScope.current = reconcile;
    // A status row changed: that workspace's status changes, with no read.
    const stopStatuses = statuses.subscribe(() => {
      let changed = false;
      const apply = (id: string, summary: SidebarSpaceSummary | undefined): SidebarSpaceSummary | undefined => {
        if (!summary || (summary.holder.kind !== 'cloud' && summary.holder.kind !== 'held') || summary.closedAt) return summary;
        const status = statuses.get(id);
        if (status === summary.status) return summary;
        changed = true;
        return { ...summary, status, freshness: status ? 'fresh' : 'unknown' };
      };
      const next = Object.fromEntries(Object.entries(accepted.current).map(([projectId, project]) => [projectId,
        { ...project, baseSummary: apply(projectId, project.baseSummary), workspaces: project.workspaces.map(space => ({ ...space, summary: apply(space.id, space.summary) })) }]));
      if (!changed) return;
      accepted.current = next;
      setDirectory(next);
    });
    const stop = channel.subscribe(reconcile);
    reconcile();
    const changed = () => { force = true; void channel.refresh(); };
    window.addEventListener(ACCOUNT_DIRECTORY_CHANGED, changed);
    return () => { stop(); stopStatuses(); reconcileScope.current = () => {}; window.removeEventListener(ACCOUNT_DIRECTORY_CHANGED, changed); };
  }, [owner, source, statuses]);
  useEffect(() => { reconcileScope.current(); }, [projectKey]);
  return { directory, acceptRuntime };
}
