import type { RelayNoticeTopic } from '@gitspace/protocol';
import { isLifecycleRunActive, type LifecycleState } from '@gitspace/protocol-environment';

/** Tells connected machines what changed; each fetches the authoritative state itself. A notice that fails to send is
 * only logged: a machine catches up on every topic whenever its relay connection opens. */
export async function notifyMachines(env: Env, machineIds: readonly string[] | 'all', topics: RelayNoticeTopic[], workspaceId?: string): Promise<void> {
  if (machineIds !== 'all' && machineIds.length === 0) return;
  try {
    await env.RELAY.getByName(env.RELAY_NAME).notifyMachines(machineIds, { topics, ...(workspaceId === undefined ? {} : { workspaceId }) });
  } catch (error) {
    console.error(JSON.stringify({ event: 'relay_notice_failed', topics, workspaceId: workspaceId ?? null, message: error instanceof Error ? error.message : String(error) }));
  }
}

/** A lifecycle change reaches the machines running this workspace's active runs, except the one that made it. */
export function notifyLifecycleHolders(env: Env, workspaceId: string, state: LifecycleState, actorMachineId: string): Promise<void> {
  const holders = new Set(state.runs.filter(run => isLifecycleRunActive(run) && run.machineId !== actorMachineId).map(run => run.machineId));
  return notifyMachines(env, [...holders], ['environment'], workspaceId);
}
