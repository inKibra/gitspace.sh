import type {
  MachineEvent,
  MachineProjectRecord,
  MachineSnapshot,
  MachineTerminalSessionRecord,
  MachineWorkspaceRecord,
  MachineAgentSessionRecord,
} from '../../lib/tmux-lite/machine/types.js';
import { applyMachineEventToSnapshot } from '../../lib/tmux-lite/machine/snapshot-patch.js';

type Listener = (snapshot: MachineSnapshot, event?: MachineEvent) => void;

export function createEmptyMachineSnapshot(snapshotNonce = 0): MachineSnapshot {
  return {
    snapshotNonce,
    generatedAt: new Date(0).toISOString(),
    projectsById: {},
    projectOrder: [],
    workspacesById: {},
    workspaceOrder: [],
    workspaceIdsByProjectId: {},
    terminalSessionsById: {},
    terminalSessionIdsByWorkspaceId: {},
    agentSessionsById: {},
    agentSessionIdsByWorkspaceId: {},
    processesById: {},
    processIdsByWorkspaceId: {},
    replaysById: {},
    replayIdsByWorkspaceId: {},
    notificationsById: {},
    notificationOrder: [],
  };
}


export class MachineStateClient {
  private snapshot: MachineSnapshot;
  private readonly listeners = new Set<Listener>();

  constructor(initialSnapshot: MachineSnapshot = createEmptyMachineSnapshot()) {
    this.snapshot = initialSnapshot;
  }

  getSnapshot(): MachineSnapshot {
    return this.snapshot;
  }

  replaceSnapshot(snapshot: MachineSnapshot): void {
    this.snapshot = snapshot;
    this.notify({ type: 'snapshot-replaced', snapshotNonce: snapshot.snapshotNonce, snapshot });
  }

  applyEvent(event: MachineEvent): MachineSnapshot {
    this.snapshot = applyMachineEventToSnapshot(this.snapshot, event);
    this.notify(event);
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(event?: MachineEvent): void {
    for (const listener of this.listeners) {
      listener(this.snapshot, event);
    }
  }
}

export function selectProjects(snapshot: MachineSnapshot): MachineProjectRecord[] {
  return snapshot.projectOrder.map((id) => snapshot.projectsById[id]).filter(Boolean);
}

export function selectWorkspaces(snapshot: MachineSnapshot): MachineWorkspaceRecord[] {
  return snapshot.workspaceOrder.map((id) => snapshot.workspacesById[id]).filter(Boolean);
}

export function selectWorkspaceTerminals(snapshot: MachineSnapshot, workspaceId: string): MachineTerminalSessionRecord[] {
  return (snapshot.terminalSessionIdsByWorkspaceId[workspaceId] ?? [])
    .map((id) => snapshot.terminalSessionsById[id])
    .filter(Boolean);
}

export function selectWorkspaceAgents(snapshot: MachineSnapshot, workspaceId: string): MachineAgentSessionRecord[] {
  return (snapshot.agentSessionIdsByWorkspaceId[workspaceId] ?? [])
    .map((id) => snapshot.agentSessionsById[id])
    .filter(Boolean);
}
