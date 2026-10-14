import { RuntimeWorkspaceStatusSchema, type RuntimeSnapshot, type RuntimeWorkspaceStatus } from '@gitspace/protocol-runtime';
import { emptyWorkspaceStatus, type WorkspaceStatusColor } from '@gitspace/protocol-workspace';

type Attachment = RuntimeSnapshot['attachments'][number];
export type MachineStatus = RuntimeWorkspaceStatus['machines'][number];

/** One attached machine as every surface shows it. Ready is computed by the cloud: online, checkout present, sync running. */
export interface WorkspaceMachine {
  id: string;
  attachment: Attachment;
  status: MachineStatus;
  label: 'Offline' | 'Starting' | 'Ready';
  color: WorkspaceStatusColor;
  ready: boolean;
  /** Setup script errors and the sync problem. They are shown beside the machine and never change ready. */
  errors: string[];
}

const NO_STATUS: RuntimeWorkspaceStatus = { summary: emptyWorkspaceStatus, cloud: { version: null, conflicts: [] }, machines: [] };

/** The workspace status summary written by the cloud. The UI reads it and never derives machine state itself. */
export function workspaceStatus(snapshot: RuntimeSnapshot | null | undefined): RuntimeWorkspaceStatus {
  const document = snapshot?.documents['gitspace.status'];
  return document === undefined || document === null ? NO_STATUS : RuntimeWorkspaceStatusSchema.parse(document);
}

export function workspaceMachines(snapshot: RuntimeSnapshot | null | undefined): WorkspaceMachine[] {
  if (!snapshot) return [];
  return workspaceStatus(snapshot).machines.flatMap((status): WorkspaceMachine[] => {
    const attachment = snapshot.attachments.find(item => item.attachmentId === status.attachmentId);
    if (!attachment) return [];
    const errors = [
      ...status.setup.flatMap(step => step.error ? [`${step.phase}: ${step.error}`] : []),
      ...(status.sync.problem ? [`sync: ${status.sync.problem}`] : []),
    ];
    const label: WorkspaceMachine['label'] = !status.online ? 'Offline' : status.ready ? 'Ready' : 'Starting';
    return [{ id: status.machineId, attachment, status, errors, ready: status.ready, label, color: label === 'Ready' ? 'green' : 'orange' }];
  });
}

export interface WorkspaceMachinesSummary { count: number; ready: number; label: WorkspaceMachine['label'] | 'No machine'; color: WorkspaceStatusColor }

/** Header line for the machines list: how many are ready, and the worst machine's label. */
export function workspaceMachinesSummary(machines: readonly WorkspaceMachine[]): WorkspaceMachinesSummary {
  const worst = machines.find(machine => machine.label === 'Offline') ?? machines.find(machine => machine.label === 'Starting') ?? machines[0];
  return { count: machines.length, ready: machines.filter(machine => machine.ready).length, label: worst?.label ?? 'No machine', color: worst?.color ?? 'dim' };
}
