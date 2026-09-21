import type { SpacePlacementView } from '@gitspace/protocol';
import type { AccountDirectorySnapshot } from '@gitspace/protocol/account-directory';
import type { BootstrapViewCodec } from '@gitspace/protocol/rpc-contract';
import type { InputOf } from 'result-rpc';
import { createContext, useEffect, useRef, useState } from 'react';
import type { SidebarProject, SidebarSpaceSummary, SidebarWorkspace } from './AppSidebar.js';
import type { ProjectLifecycleView, WorkspaceView } from './GitSpaceShell.js';
import { createGitSpaceBrowserClient, rpcClient } from './rpc-client.js';
import { ACCOUNT_DIRECTORY_CHANGED } from './routes.js';
import { useSynchronizationOwner } from './SynchronizationProvider.js';
import { accountDirectorySource } from './account-directory-transport.js';
import type { SynchronizationSource } from './synchronization.js';

export type Directory = Record<string, Pick<SidebarProject, 'workspaces' | 'baseSummary' | 'error'>>;
export interface DirectoryClient {
  bootstrap(input: { projectId: string; workspaceId: string | null }, options: { signal: AbortSignal; endpoint: string }): Promise<{ status: 'ok'; value: Pick<InputOf<typeof BootstrapViewCodec>, 'baseSpace' | 'workspaces'> } | { status: 'error'; error: Error }>;
}
const runtimeClients = new Map<string, Pick<typeof rpcClient, 'bootstrap'>>();
const directoryClient: DirectoryClient = {
  bootstrap(input, { signal, endpoint }) {
    let client = runtimeClients.get(endpoint);
    if (!client) { client = createGitSpaceBrowserClient({ url: endpoint }); runtimeClients.set(endpoint, client); }
    return client.bootstrap(input, { signal });
  },
};
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

/** One account projection owns cloud lifecycle; native reads only enrich current holders. */
export function useAccountDirectory(projects: readonly Pick<ProjectLifecycleView, 'id' | 'lifecycle'>[], client: DirectoryClient = directoryClient, source: SynchronizationSource<AccountDirectorySnapshot> = accountDirectorySource): Directory {
  const owner = useSynchronizationOwner();
  const accepted = useRef<Directory>({});
  const [directory, setDirectory] = useState<Directory>(accepted.current);
  const scope = useRef(projects);
  scope.current = projects;
  const reconcileScope = useRef(() => {});
  const projectKey = JSON.stringify(projects.map(({ id, lifecycle }) => ({ id, lifecycle })));
  useEffect(() => {
    const controller = new AbortController();
    const channel = owner.channel('account-directory', source);
    type ProjectWork = { key: string; revision: number; reading: boolean; pending: (() => Promise<void>) | null; directoryFailed: boolean; holderKeys: Map<string, string>; holderErrors: Map<string, string> };
    const work = new Map<string, ProjectWork>();
    let force = false;
    const reconcile = () => {
      const snapshot = channel.snapshot();
      const value = snapshot.value;
      const projectIds = new Set(value?.projects.filter((project) => project.lifecycle !== 'cloud-only' && project.lifecycle !== 'deleting').map((project) => project.id));
      const entries = scope.current.filter((project) => project.lifecycle !== 'cloud-only' && project.lifecycle !== 'deleting' && (!value || projectIds.has(project.id)));
      const ids = new Set(entries.map((project) => project.id));
      for (const [id, state] of work) if (!ids.has(id)) { state.revision++; state.pending = null; work.delete(id); }
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
        let state = work.get(project.id);
        if (state?.key === key && !refreshAll) continue;
        if (!state) { state = { key, revision: 0, reading: false, pending: null, directoryFailed: false, holderKeys: new Map(), holderErrors: new Map() }; work.set(project.id, state); }
        state.key = key;
        const currentWork = state;
        const refreshProject = refreshAll || currentWork.directoryFailed;
        currentWork.directoryFailed = directoryError !== null;
        const revision = ++state.revision;
        const current = () => !controller.signal.aborted && work.get(project.id) === currentWork && currentWork.revision === revision;
        const prior = accepted.current[project.id];
        const placements = new Map<string, SpacePlacementView>(placementValues.map((space) => [space.spaceId, space]));
        const definitionsById = new Map(definitions.map((space) => [space.id, space]));
        const holderInputs = new Map<string, unknown[]>();
        for (const placement of placementValues) {
          let input = holderInputs.get(placement.holderId);
          if (!input) { input = []; holderInputs.set(placement.holderId, input); }
          input.push([placement, definitionsById.get(placement.spaceId)]);
        }
        const holderKeys = new Map([...holderInputs].map(([id, input]) => {
          const machine = machines.get(id);
          return [id, JSON.stringify([value?.projectRevisions[project.id], input, machine?.state, machine?.desiredState, machine?.rpcEndpoint])];
        }));
        for (const id of currentWork.holderKeys.keys()) if (!holderInputs.has(id)) { currentWork.holderKeys.delete(id); currentWork.holderErrors.delete(id); }
        const reusedHolders = new Set<string>();
        const previousWorkspaces = new Map(prior?.workspaces.map((space) => [space.id, space]));
        const workspaces: SidebarWorkspace[] = value ? definitions.filter((space) => space.kind !== 'base' && space.lifecycle !== 'deleting').map((space) => ({
          id: space.id, projectId: space.projectId, name: space.name, branch: space.branch, closedAt: space.archivedAt ? new Date(space.archivedAt) : null, definition: space,
        })) : prior?.workspaces ?? [];
        const summaries = new Map<string, SidebarSpaceSummary>();
        const runtimes = new Map<string, WorkspaceView>();
        const holders = new Map<string, SpacePlacementView>();
        const errors = directoryError ? [`Directory unavailable: ${directoryError}`] : [];
        const summarize = (id: string, closedAt: Date | null, previous: SidebarSpaceSummary | undefined): SidebarSpaceSummary => {
          const placement = placements.get(id);
          if (closedAt) return { closedAt, holder: { kind: 'released' }, generation: placement?.generation, freshness: 'fresh' };
          if (!placement) return { closedAt, holder: { kind: 'unknown' }, freshness: 'unknown', refreshing: false, detail: 'Placement unavailable' };
          const machine = machines.get(placement.holderId);
          const released = placement.state === 'closed' || (placement.holderId === 'unassigned' && placement.state !== 'opening');
          const compatible = !previous?.closedAt && previous?.holder.kind === 'held' && previous.holder.machineId === placement.holderId && previous.generation === placement.generation;
          const summary: SidebarSpaceSummary = {
            closedAt, generation: placement.generation,
            holder: released ? { kind: 'released' } : placement.holderId === 'unassigned' ? { kind: 'unknown' } : { kind: 'held', machineId: placement.holderId, label: machine?.label ?? (compatible && previous?.holder.kind === 'held' ? previous.holder.label : placement.holderId) },
            freshness: 'fresh',
          };
          if (released) return summary;
          if (placement.state !== 'open') {
            currentWork.holderKeys.delete(placement.holderId);
            return { ...summary, detail: placement.state === 'opening' ? 'Opening' : placement.state === 'closing' ? 'Closing' : 'Status unknown' };
          }
          const status = compatible ? previous?.status : undefined;
          const unavailable = directoryError ? `Directory unavailable: ${directoryError}` : !machine || machine.state !== 'online' || machine.desiredState !== 'online' || !placement.endpoint ? 'Machine offline · status unavailable' : null;
          if (unavailable) {
            currentWork.holderKeys.delete(placement.holderId);
            return { ...summary, status, freshness: status ? 'stale' : 'unknown', refreshing: false, detail: unavailable };
          }
          if (!refreshProject && compatible && currentWork.holderKeys.get(placement.holderId) === holderKeys.get(placement.holderId)) {
            const error = currentWork.holderErrors.get(placement.holderId);
            if (error && !reusedHolders.has(placement.holderId)) errors.push(error);
            reusedHolders.add(placement.holderId);
            return { ...summary, status, freshness: previous?.freshness ?? 'unknown', refreshing: false, detail: previous?.detail };
          }
          holders.set(placement.holderId, holders.get(placement.holderId) ?? placement);
          return { ...summary, status, freshness: status ? previous?.freshness ?? 'fresh' : 'unknown', refreshing: true, detail: compatible ? previous?.detail : null };
        };
        const base = definitions.find((space) => space.kind === 'base' && space.lifecycle !== 'deleting');
        if (base || (!value && prior?.baseSummary)) summaries.set(project.id, summarize(project.id, base ? base.archivedAt ? new Date(base.archivedAt) : null : prior?.baseSummary?.closedAt ?? null, prior?.baseSummary));
        for (const space of workspaces) {
          const previous = previousWorkspaces.get(space.id);
          const summary = summarize(space.id, space.closedAt, previous?.summary);
          summaries.set(space.id, summary);
          const runtime = previous?.runtime;
          if (runtime && !space.closedAt && !runtime.closedAt && runtime.projectId === project.id && summary.holder.kind === 'held' && runtime.possessedBy === summary.holder.machineId && runtime.generation === summary.generation && placements.get(space.id)?.state === 'open') runtimes.set(space.id, runtime);
        }
        const publish = (error: string | null) => {
          if (!current()) return;
          accepted.current = { ...accepted.current, [project.id]: {
            baseSummary: summaries.get(project.id),
            workspaces: workspaces.map((space) => ({ ...space, summary: summaries.get(space.id), runtime: runtimes.get(space.id) })), error,
          } };
          setDirectory(accepted.current);
        };
        // Cloud closes, deletes and generation changes take effect even while old native reads are pending.
        publish(errors.length ? errors.join('; ') : holders.size ? prior?.error ?? null : null);
        currentWork.pending = async () => {
          if (!current()) return;
          await Promise.all([...holders].map(async ([holderId, placement]) => {
            const runtime = await readResult(client.bootstrap({ projectId: project.id, workspaceId: placement.spaceId === project.id ? null : placement.spaceId }, { signal: controller.signal, endpoint: placement.endpoint! }));
            if (!current()) return;
            if (runtime.value) {
              for (const space of [runtime.value.baseSpace, ...runtime.value.workspaces]) {
                const summary = summaries.get(space.id);
                const placement = placements.get(space.id);
                const matchesHolder = space.possessedBy === holderId || (space.closedAt !== null && space.possessedBy === null);
                if (summary && summary.refreshing && space.projectId === project.id && matchesHolder && placement?.holderId === holderId && placement.state === 'open' && space.spaceGeneration === placement.generation && summary.generation === placement.generation) {
                  if (space.closedAt) {
                    runtimes.delete(space.id);
                    summaries.set(space.id, { ...summary, status: undefined });
                    continue;
                  }
                  summaries.set(space.id, { ...summary, status: space.status, freshness: 'fresh', refreshing: false, detail: null });
                  if ('phase' in space) runtimes.set(space.id, {
                    kind: 'workspace', id: space.id, projectId: space.projectId, projectName: space.projectName, name: space.name,
                    branch: space.branch, phase: space.phase, generation: space.spaceGeneration, possessedBy: holderId, holder: summary.holder,
                    status: space.status, closedAt: space.closedAt, relations: space.relations, stack: space.stack,
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
            currentWork.holderKeys.set(holderId, holderKeys.get(holderId)!);
            const error = runtime.error ?? (missing ? 'Status unavailable for current holder and generation' : null);
            if (error) { errors.push(error); currentWork.holderErrors.set(holderId, error); }
            else currentWork.holderErrors.delete(holderId);
          }));
          publish(errors.length ? errors.join('; ') : null);
        };
        if (!currentWork.reading) {
          currentWork.reading = true;
          void (async () => {
            try {
              while (currentWork.pending && !controller.signal.aborted) {
                const refresh = currentWork.pending;
                currentWork.pending = null;
                await refresh();
              }
            } finally { currentWork.reading = false; }
          })();
        }
      }
    };
    reconcileScope.current = reconcile;
    const stop = channel.subscribe(reconcile);
    reconcile();
    const changed = () => { force = true; void channel.refresh(); };
    window.addEventListener(ACCOUNT_DIRECTORY_CHANGED, changed);
    return () => { controller.abort(); stop(); reconcileScope.current = () => {}; window.removeEventListener(ACCOUNT_DIRECTORY_CHANGED, changed); };
  }, [client, owner, source]);
  useEffect(() => { reconcileScope.current(); }, [projectKey]);
  return directory;
}
