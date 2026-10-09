import { useState } from 'react';
import type { RuntimeSnapshot } from '@gitspace/protocol-runtime';
import { RuntimeExecutionDocumentSchema } from '@gitspace/protocol-runtime/workspace-controls';
import { cachePresentation, partitionAttachments } from './environment/cache-presentation.js';
import { useCacheFreshnessClock } from './environment/useCacheFreshnessClock.js';

/** A human run may use an explicit default or the sole ready cache, never the first online machine. */
export function useWorkspaceRunMachine(snapshot: RuntimeSnapshot | null | undefined) {
  const now = useCacheFreshnessClock();
  const [choice, setChoice] = useState<{ spaceId: string; machineId: string } | null>(null);
  const machines = partitionAttachments(snapshot?.attachments ?? []).live.flatMap(attachment => {
    if (attachment.role !== 'cache') return [];
    const status = cachePresentation(attachment, now);
    if (!status.ready && status.label !== 'Paused' && status.label !== 'Reclaimed') return [];
    return [{ id: attachment.machineId, ready: status.ready, state: status.label }];
  });
  const execution = RuntimeExecutionDocumentSchema.parse(snapshot?.documents['gitspace.execution'] ?? { defaultMachineId: null });
  const ready = machines.filter(machine => machine.ready);
  const selectedId = choice?.spaceId === snapshot?.workspaceId ? choice?.machineId
    : execution.defaultMachineId ?? (ready.length === 1 ? ready[0]?.id : undefined);
  const machine = machines.find(candidate => candidate.id === selectedId) ?? null;
  return { machines, machine, select: (machineId: string) => {
    if (snapshot) setChoice({ spaceId: snapshot.workspaceId, machineId });
  } };
}
