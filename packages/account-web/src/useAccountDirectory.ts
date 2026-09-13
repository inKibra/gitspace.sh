import type { SpacePlacementView } from '@gitspace/protocol';
import { createContext, useEffect, useRef, useState } from 'react';
import type { SidebarProject, SidebarSpaceSummary, SidebarWorkspace } from './AppSidebar.js';
import type { ProjectLifecycleView, WorkspaceView } from './GitSpaceShell.js';
import { rpcClient } from './rpc-client.js';
import { ACCOUNT_DIRECTORY_CHANGED } from './routes.js';
import { useSynchronizationOwner } from './SynchronizationProvider.js';

export type Directory = Record<string, Pick<SidebarProject, 'workspaces' | 'baseSummary' | 'error'>>;
export type DirectoryClient = Pick<typeof rpcClient, 'inspector' | 'placements' | 'machines' | 'bootstrap' | 'project' | 'space' | 'machine'>;
export const AccountDirectoryContext = createContext<{
  projects: readonly ProjectLifecycleView[];
  directory: Directory;
  loading: boolean;
  refresh: () => void;
} | null>(null);
type ReadResult<T> = { value: T; error: null } | { value: null; error: string };

async function readResult<T>(request: Promise<{ status: 'ok'; value: T } | { status: 'error'; error: Error }>): Promise<ReadResult<T>> {
  try {
    const result = await request;
    return result.status === 'ok' ? { value: result.value, error: null } : { value: null, error: result.error.message };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Account-owned reads never depend on the selected pane or mount a workspace. */
export function useAccountDirectory(projects: readonly Pick<ProjectLifecycleView, 'id' | 'lifecycle'>[], client: DirectoryClient = rpcClient): Directory {
  const owner = useSynchronizationOwner();
  const accepted = useRef<Directory>({});
  const [directory, setDirectory] = useState<Directory>(accepted.current);
  const projectKey = JSON.stringify(projects.map(({ id, lifecycle }) => ({ id, lifecycle })));
  useEffect(() => {
    const entries = (JSON.parse(projectKey) as Array<Pick<ProjectLifecycleView, 'id' | 'lifecycle'>>)
      .filter((project) => project.lifecycle !== 'cloud-only' && project.lifecycle !== 'deleting');
    const controller = new AbortController();
    const ids = new Set(entries.map((project) => project.id));
    if (Object.keys(accepted.current).some((id) => !ids.has(id))) {
      accepted.current = Object.fromEntries(Object.entries(accepted.current).filter(([id]) => ids.has(id)));
      setDirectory(accepted.current);
    }
    let loading = false;
    let dirty = false;
    const revisions = new Map(entries.map((project) => [project.id, 0]));
    const pendingProjects = new Set(entries.map((project) => project.id));
    const subscriptions = new Map<string, () => void>();
    const refresh = async (): Promise<void> => {
      if (!entries.length || controller.signal.aborted) return;
      if (loading) { dirty = true; return; }
      loading = true;
      const targets = entries.filter((project) => pendingProjects.has(project.id));
      pendingProjects.clear();
      try {
        // These sources fail independently: a machine-list failure must not hide a confirmed close or move.
        const fleet = Promise.all([
          readResult(client.placements({}, { signal: controller.signal })),
          readResult(client.machines({}, { signal: controller.signal })),
        ]);
        await Promise.all(targets.map(async (project) => {
          const requestedRevision = revisions.get(project.id);
          const saved = await readResult(client.inspector.bootstrap({ projectId: project.id, workspaceId: null }, { signal: controller.signal }));
          const [placementResult, machineResult] = await fleet;
          if (controller.signal.aborted || revisions.get(project.id) !== requestedRevision) return;
          for (const space of saved.value?.workspaces ?? []) {
            const resource = `space:${space.id}`;
            if (subscriptions.has(resource)) continue;
            const channel = owner.channel(resource, (after, signal) => client.space.events({ spaceId: space.id, after }, { signal }));
            let cursor: number | null = null;
            subscriptions.set(resource, channel.subscribe(() => {
              const next = channel.snapshot();
              if (next.cursor === null || next.cursor === cursor) return;
              cursor = next.cursor;
              changed(project.id);
            }));
          }
          const prior = accepted.current[project.id];
          const placements = new Map<string, SpacePlacementView>(placementResult.value?.spaces.filter((space) => space.projectId === project.id).map((space) => [space.spaceId, space]));
          const machines = new Map(machineResult.value?.map((machine) => [machine.id, machine]));
          const errors = [saved.error && `Directory unavailable: ${saved.error}`, placementResult.error && `Placement unavailable: ${placementResult.error}`, machineResult.error && `Machine directory unavailable: ${machineResult.error}`].filter((error): error is string => !!error);
          const previousWorkspaces = new Map(prior?.workspaces.map((space) => [space.id, space]));
          const workspaces: SidebarWorkspace[] = saved.value ? saved.value.workspaces.filter((space) => space.projectId === project.id && space.kind !== 'base' && space.lifecycle !== 'deleting').map((space) => ({
            id: space.id, projectId: space.projectId, name: space.name, branch: space.branch, closedAt: space.archivedAt ? new Date(space.archivedAt) : null, definition: space,
          })) : prior?.workspaces ?? [];
          const summaries = new Map<string, SidebarSpaceSummary>();
          const runtimes = new Map<string, WorkspaceView>();
          const holders = new Map<string, string>();
          const summarize = (id: string, closedAt: Date | null, previous: SidebarSpaceSummary | undefined): SidebarSpaceSummary => {
            const placement = placements.get(id);
            if (closedAt) return { closedAt, holder: { kind: 'released' }, generation: placement?.generation, freshness: 'fresh' };
            if (!placement) {
              const retained = placementResult.value === null && !previous?.closedAt ? previous : undefined;
              return {
                ...retained, closedAt, holder: retained?.holder ?? { kind: 'unknown' },
                freshness: retained ? 'stale' : 'unknown', refreshing: false,
                detail: placementResult.error !== null ? `Placement unavailable: ${placementResult.error}` : 'Placement unavailable',
              };
            }
            const machine = machines.get(placement.holderId);
            const released = placement.state === 'closed' || (placement.holderId === 'unassigned' && placement.state !== 'opening');
            const compatible = !previous?.closedAt && previous?.holder.kind === 'held' && previous.holder.machineId === placement.holderId && previous.generation === placement.generation;
            const summary: SidebarSpaceSummary = {
              closedAt, generation: placement.generation,
              holder: released ? { kind: 'released' } : placement.holderId === 'unassigned' ? { kind: 'unknown' } : { kind: 'held', machineId: placement.holderId, label: machine?.label ?? (compatible && previous?.holder.kind === 'held' ? previous.holder.label : placement.holderId) },
              freshness: 'fresh',
            };
            if (released) return summary;
            if (placement.state !== 'open') return { ...summary, detail: placement.state === 'opening' ? 'Opening' : placement.state === 'closing' ? 'Closing' : 'Status unknown' };
            const status = compatible ? previous?.status : undefined;
            const unavailable = machineResult.error ? `Machine directory unavailable: ${machineResult.error}` : !machine || machine.state !== 'online' || machine.desiredState !== 'online' || !placement.endpoint ? 'Machine offline · status unavailable' : null;
            if (unavailable) return { ...summary, status, freshness: status ? 'stale' : 'unknown', detail: unavailable };
            holders.set(placement.holderId, holders.get(placement.holderId) ?? id);
            // An in-flight read is not a new entity state. Keep accepted status and any failure until recovery is confirmed.
            return { ...summary, status, freshness: status ? previous?.freshness ?? 'fresh' : 'unknown', refreshing: true, detail: compatible ? previous?.detail : null };
          };
          const base = saved.value?.workspaces.find((space) => space.projectId === project.id && space.kind === 'base');
          if (base || (!saved.value && prior?.baseSummary)) summaries.set(project.id, summarize(project.id, base ? base.archivedAt ? new Date(base.archivedAt) : null : prior?.baseSummary?.closedAt ?? null, prior?.baseSummary));
          for (const space of workspaces) {
            const previous = previousWorkspaces.get(space.id);
            const summary = summarize(space.id, space.closedAt, previous?.summary);
            summaries.set(space.id, summary);
            const runtime = previous?.runtime;
            if (runtime && !space.closedAt && !runtime.closedAt && runtime.projectId === project.id && summary.holder.kind === 'held' && runtime.possessedBy === summary.holder.machineId && runtime.generation === summary.generation && (placementResult.value === null || placements.get(space.id)?.state === 'open')) {
              runtimes.set(space.id, runtime);
            }
          }
          const publish = (error: string | null): void => {
            if (controller.signal.aborted || revisions.get(project.id) !== requestedRevision) return;
            accepted.current = { ...accepted.current, [project.id]: {
              baseSummary: summaries.get(project.id),
              workspaces: workspaces.map((space) => ({ ...space, summary: summaries.get(space.id), runtime: runtimes.get(space.id) })),
              error,
            } };
            setDirectory(accepted.current);
          };
          // Publish cloud lifecycle changes immediately, without clearing compatible status or a pending failure.
          publish(errors.length ? errors.join('; ') : holders.size ? prior?.error ?? null : null);
          await Promise.all([...holders].map(async ([holderId, representative]) => {
            const runtime = await readResult(client.bootstrap({ projectId: project.id, workspaceId: representative === project.id ? null : representative }, { signal: controller.signal }));
            if (controller.signal.aborted || revisions.get(project.id) !== requestedRevision) return;
            if (runtime.value) {
              for (const space of [runtime.value.baseSpace, ...runtime.value.workspaces]) {
                const summary = summaries.get(space.id);
                const placement = placements.get(space.id);
                // Closed native records can have already released possession; never accept their metadata as a live runtime.
                const matchesHolder = space.possessedBy === holderId || (space.closedAt !== null && space.possessedBy === null);
                if (summary && summary.refreshing && space.projectId === project.id && matchesHolder && placement?.holderId === holderId && placement.state === 'open' && space.spaceGeneration === placement.generation && summary.generation === placement.generation) {
                  if (space.closedAt) {
                    runtimes.delete(space.id);
                    summaries.set(space.id, { ...summary, status: undefined });
                    continue;
                  }
                  summaries.set(space.id, { ...summary, status: space.status, freshness: 'fresh', refreshing: false, detail: null });
                  if ('phase' in space) runtimes.set(space.id, {
                    kind: 'workspace',
                    id: space.id,
                    projectId: space.projectId,
                    projectName: space.projectName,
                    name: space.name,
                    branch: space.branch,
                    phase: space.phase,
                    generation: space.spaceGeneration,
                    possessedBy: holderId,
                    holder: summary.holder,
                    status: space.status,
                    closedAt: space.closedAt,
                    relations: space.relations,
                    stack: space.stack,
                  });
                }
              }
            }
            let missing = false;
            for (const [id, summary] of summaries) {
              if (placements.get(id)?.holderId !== holderId || !summary.refreshing) continue;
              missing = true;
              summaries.set(id, { ...summary, freshness: summary.status ? 'stale' : 'unknown', refreshing: false, detail: runtime.error ? `Status unavailable: ${runtime.error}` : 'Status unavailable for current holder and generation' });
            }
            if (runtime.error) errors.push(runtime.error);
            else if (missing) errors.push('Status unavailable for current holder and generation');
          }));
          publish(errors.length ? errors.join('; ') : null);
        }));
      } finally {
        loading = false;
        if (dirty && !controller.signal.aborted) { dirty = false; void refresh(); }
      }
    };
    const changed = (projectId?: string) => {
      for (const project of entries) {
        if (projectId && project.id !== projectId) continue;
        revisions.set(project.id, (revisions.get(project.id) ?? 0) + 1);
        pendingProjects.add(project.id);
      }
      void refresh();
    };
    const changedAll = () => changed();
    for (const project of entries) {
      const channel = owner.channel(`project:${project.id}`, (after, signal) => client.project.events({ projectId: project.id, after }, { signal }));
      let cursor: number | null = null;
      subscriptions.set(`project:${project.id}`, channel.subscribe(() => {
        const next = channel.snapshot();
        if (next.cursor === null || next.cursor === cursor) return;
        cursor = next.cursor;
        changed(project.id);
      }));
    }
    const fleetChannel = owner.channel('machines', (after, signal) => client.machine.events({ after }, { signal }));
    let fleetCursor: number | null = null;
    subscriptions.set('machines', fleetChannel.subscribe(() => {
      const next = fleetChannel.snapshot();
      if (next.cursor === null || next.cursor === fleetCursor) return;
      fleetCursor = next.cursor;
      changed();
    }));
    if (entries.length) void refresh();
    window.addEventListener(ACCOUNT_DIRECTORY_CHANGED, changedAll);
    return () => { controller.abort(); for (const stop of subscriptions.values()) stop(); window.removeEventListener(ACCOUNT_DIRECTORY_CHANGED, changedAll); };
  }, [projectKey, client, owner]);
  return directory;
}
