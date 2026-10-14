import { z } from 'zod';
import { RuntimeDispatchSelectionSchema, RuntimeMachineIdSchema, type RuntimeAttachment } from '@gitspace/protocol-runtime';
import { isAttachmentReady, type WorkspaceRuntime } from '@gitspace/runtime-workspace-do';

const selectionState = z.object({ fingerprint: z.string(), deadline: z.string(), result: z.unknown().optional() });
export type DispatchSelectionState = z.infer<typeof selectionState>;

export function createDispatchSelector(options: { storage: DurableObjectStorage; env: Env; identity: { projectId: string; workspaceId: string }; runtime(): WorkspaceRuntime }) {
  const { storage, env, identity } = options;
  storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_host_selection (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
  const load = (id: string) => {
    const row = storage.sql.exec<{ state: string }>('SELECT state FROM runtime_host_selection WHERE id=?', id).toArray()[0];
    return row ? selectionState.parse(JSON.parse(row.state)) : null;
  };
  const save = (id: string, state: DispatchSelectionState) => storage.sql.exec('INSERT INTO runtime_host_selection(id,state) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state', id, JSON.stringify(state));
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${identity.projectId}`);
  async function cache(args: unknown, eligible?: readonly RuntimeAttachment[]): Promise<RuntimeAttachment> {
    const selection = RuntimeDispatchSelectionSchema.parse(args);
    const now = Date.now();
    let candidates = (eligible ?? options.runtime().attachments.list()).filter(item => isAttachmentReady(item, now));
    const selector = selection.on;
    if (typeof selector === 'string') {
      let machineId = candidates.find(item => item.machineId === selector)?.machineId;
      if (!machineId) {
        const fleet = await env.FLEET_CATALOG.getByName(env.ACCOUNT_ID).listMachines();
        const named = fleet.filter(item => item.id === selector || item.label === selector);
        if (named.length > 1) throw new Error('Machine label is ambiguous; use its id');
        machineId = named[0] ? RuntimeMachineIdSchema.parse(named[0].id) : undefined;
      }
      candidates = candidates.filter(item => item.machineId === machineId);
    } else if (selector) {
      if (selector.needs) candidates = candidates.filter(item => selector.needs!.every(need => item.capabilities.includes(need)));
      if (selector.profile) {
        const lifecycle = await authority.getLifecycleState(identity.workspaceId);
        candidates = candidates.filter(item => ['machine/prepare', 'checks'].every(phase => lifecycle.runs.some(run => run.machineId === item.machineId && run.profile === selector.profile && run.phase === phase && run.status === 'succeeded')));
      }
      if (selector.prefer === 'idle') {
        const idle = (item: RuntimeAttachment) => {
          const observation = item.executionObservation;
          const age = observation ? Date.now() - Date.parse(observation.observedAt) : Infinity;
          return observation && age >= -5000 && age <= 30000 && observation.activeExecutions === 0 ? 1 : 0;
        };
        candidates.sort((a, b) => idle(b) - idle(a));
      }
    }
    const selected = candidates[0];
    if (!selected) throw new Error('No ready machine: start GitSpace on an attached machine and wait for its checkout to sync, or attach another machine.');
    return selected;
  }
  return { load, save, cache };
}
