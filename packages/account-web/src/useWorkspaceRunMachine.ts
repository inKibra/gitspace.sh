import { useState } from 'react';
import type { RuntimeSnapshot } from '@gitspace/protocol-runtime';
import { workspaceMachines } from './workspace-status.js';

/** Every attached machine is offered, including one whose setup failed.
 * A human run defaults to the sole attached machine, never the first online machine. */
export function useWorkspaceRunMachine(snapshot: RuntimeSnapshot | null | undefined) {
  const [choice, setChoice] = useState<{ spaceId: string; machineId: string } | null>(null);
  const machines = workspaceMachines(snapshot);
  const selectedId = choice?.spaceId === snapshot?.workspaceId ? choice?.machineId : machines.length === 1 ? machines[0]?.id : undefined;
  const machine = machines.find(candidate => candidate.id === selectedId) ?? null;
  return { machines, machine, select: (machineId: string) => {
    if (snapshot) setChoice({ spaceId: snapshot.workspaceId, machineId });
  } };
}
