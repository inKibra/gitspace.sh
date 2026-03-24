import type {
  MachineAgentSessionRecord,
  MachineEvent,
  MachineProjectRecord,
  MachineSnapshot,
  MachineTerminalSessionRecord,
  MachineWorkspaceRecord,
} from '../../lib/tmux-lite/machine/types.js';

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

function ensureUniqueId(list: string[], id: string): string[] {
  return list.includes(id) ? list : [...list, id];
}

function removeId(list: string[], id: string): string[] {
  return list.filter((item) => item !== id);
}

function applyWorkspaceUpsert(snapshot: MachineSnapshot, workspace: MachineWorkspaceRecord): MachineSnapshot {
  const workspacesById = { ...snapshot.workspacesById, [workspace.id]: workspace };
  const workspaceOrder = ensureUniqueId(snapshot.workspaceOrder, workspace.id);
  const currentWorkspaceIds = snapshot.workspaceIdsByProjectId[workspace.projectId] ?? [];
  return {
    ...snapshot,
    generatedAt: new Date().toISOString(),
    workspacesById,
    workspaceOrder,
    workspaceIdsByProjectId: {
      ...snapshot.workspaceIdsByProjectId,
      [workspace.projectId]: ensureUniqueId(currentWorkspaceIds, workspace.id),
    },
  };
}

function applyWorkspaceRemoved(snapshot: MachineSnapshot, workspaceId: string): MachineSnapshot {
  const existing = snapshot.workspacesById[workspaceId];
  if (!existing) return snapshot;
  const workspacesById = { ...snapshot.workspacesById };
  delete workspacesById[workspaceId];
  return {
    ...snapshot,
    generatedAt: new Date().toISOString(),
    workspacesById,
    workspaceOrder: removeId(snapshot.workspaceOrder, workspaceId),
    workspaceIdsByProjectId: {
      ...snapshot.workspaceIdsByProjectId,
      [existing.projectId]: removeId(snapshot.workspaceIdsByProjectId[existing.projectId] ?? [], workspaceId),
    },
  };
}

function applyTerminalSessionUpsert(snapshot: MachineSnapshot, session: MachineTerminalSessionRecord): MachineSnapshot {
  const terminalSessionsById = { ...snapshot.terminalSessionsById, [session.id]: session };
  const terminalSessionIdsByWorkspaceId = session.workspaceId
    ? {
        ...snapshot.terminalSessionIdsByWorkspaceId,
        [session.workspaceId]: ensureUniqueId(snapshot.terminalSessionIdsByWorkspaceId[session.workspaceId] ?? [], session.id),
      }
    : snapshot.terminalSessionIdsByWorkspaceId;
  return {
    ...snapshot,
    generatedAt: new Date().toISOString(),
    terminalSessionsById,
    terminalSessionIdsByWorkspaceId,
  };
}

function applyTerminalSessionRemoved(snapshot: MachineSnapshot, sessionId: string, workspaceId?: string): MachineSnapshot {
  const terminalSessionsById = { ...snapshot.terminalSessionsById };
  const existing = terminalSessionsById[sessionId];
  if (!existing) return snapshot;
  delete terminalSessionsById[sessionId];
  const wid = workspaceId ?? existing.workspaceId;
  return {
    ...snapshot,
    generatedAt: new Date().toISOString(),
    terminalSessionsById,
    terminalSessionIdsByWorkspaceId: wid
      ? {
          ...snapshot.terminalSessionIdsByWorkspaceId,
          [wid]: removeId(snapshot.terminalSessionIdsByWorkspaceId[wid] ?? [], sessionId),
        }
      : snapshot.terminalSessionIdsByWorkspaceId,
  };
}

function applyAgentSessionUpsert(snapshot: MachineSnapshot, session: MachineAgentSessionRecord): MachineSnapshot {
  const agentSessionsById = { ...snapshot.agentSessionsById, [session.id]: session };
  return {
    ...snapshot,
    generatedAt: new Date().toISOString(),
    agentSessionsById,
    agentSessionIdsByWorkspaceId: {
      ...snapshot.agentSessionIdsByWorkspaceId,
      [session.workspaceId]: ensureUniqueId(snapshot.agentSessionIdsByWorkspaceId[session.workspaceId] ?? [], session.id),
    },
  };
}

function applyAgentSessionRemoved(snapshot: MachineSnapshot, sessionId: string, workspaceId: string): MachineSnapshot {
  const agentSessionsById = { ...snapshot.agentSessionsById };
  if (!agentSessionsById[sessionId]) return snapshot;
  delete agentSessionsById[sessionId];
  return {
    ...snapshot,
    generatedAt: new Date().toISOString(),
    agentSessionsById,
    agentSessionIdsByWorkspaceId: {
      ...snapshot.agentSessionIdsByWorkspaceId,
      [workspaceId]: removeId(snapshot.agentSessionIdsByWorkspaceId[workspaceId] ?? [], sessionId),
    },
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
    switch (event.type) {
      case 'snapshot-replaced':
        this.snapshot = event.snapshot;
        break;
      case 'workspace-upserted':
        this.snapshot = applyWorkspaceUpsert({ ...this.snapshot, snapshotNonce: event.snapshotNonce }, event.workspace);
        break;
      case 'workspace-removed':
        this.snapshot = applyWorkspaceRemoved({ ...this.snapshot, snapshotNonce: event.snapshotNonce }, event.workspaceId);
        break;
      case 'terminal-session-upserted':
        this.snapshot = applyTerminalSessionUpsert({ ...this.snapshot, snapshotNonce: event.snapshotNonce }, event.session);
        break;
      case 'terminal-session-removed':
        this.snapshot = applyTerminalSessionRemoved({ ...this.snapshot, snapshotNonce: event.snapshotNonce }, event.sessionId, event.workspaceId);
        break;
      case 'agent-session-upserted':
        this.snapshot = applyAgentSessionUpsert({ ...this.snapshot, snapshotNonce: event.snapshotNonce }, event.session);
        break;
      case 'agent-session-removed':
        this.snapshot = applyAgentSessionRemoved({ ...this.snapshot, snapshotNonce: event.snapshotNonce }, event.sessionId, event.workspaceId);
        break;
    }
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
