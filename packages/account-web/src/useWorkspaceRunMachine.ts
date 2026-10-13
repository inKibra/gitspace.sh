import { useState } from 'react';
import type { RuntimeSnapshot } from '@gitspace/protocol-runtime';
import { RuntimeExecutionDocumentSchema } from '@gitspace/protocol-runtime/workspace-controls';
import { attachedMachines } from './environment/cache-presentation.js';
import { useCacheFreshnessClock } from './environment/useCacheFreshnessClock.js';

/** Every attached machine is offered, including one whose setup failed: choosing it is how setup is re-run.
 * A human run defaults to an explicit default or the sole attached machine, never the first online machine. */
export function useWorkspaceRunMachine(snapshot: RuntimeSnapshot | null | undefined) {
  const now = useCacheFreshnessClock();
  const [choice, setChoice] = useState<{ spaceId: string; machineId: string } | null>(null);
  const machines = attachedMachines(snapshot?.attachments ?? [], now);
  const execution = RuntimeExecutionDocumentSchema.parse(snapshot?.documents['gitspace.execution'] ?? { defaultMachineId: null });
  const selectedId = choice?.spaceId === snapshot?.workspaceId ? choice?.machineId
    : execution.defaultMachineId ?? (machines.length === 1 ? machines[0]?.id : undefined);
  const machine = machines.find(candidate => candidate.id === selectedId) ?? null;
  return { machines, machine, select: (machineId: string) => {
    if (snapshot) setChoice({ spaceId: snapshot.workspaceId, machineId });
  } };
}
