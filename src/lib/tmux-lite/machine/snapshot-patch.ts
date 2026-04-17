import type {
  MachineAgentSessionRecord,
  MachineEvent,
  MachineSnapshot,
  MachineTerminalSessionRecord,
  MachineWorkspaceRecord,
} from './types.js';

function ensureUniqueId(list: string[], id: string): string[] {
  return list.includes(id) ? list : [...list, id];
}

function removeId(list: string[], id: string): string[] {
  return list.filter((item) => item !== id);
}

export function applyWorkspaceUpsert(snapshot: MachineSnapshot, workspace: MachineWorkspaceRecord): MachineSnapshot {
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

export function applyWorkspaceRemoved(snapshot: MachineSnapshot, workspaceId: string): MachineSnapshot {
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

export function applyTerminalSessionUpsert(snapshot: MachineSnapshot, session: MachineTerminalSessionRecord): MachineSnapshot {
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

export function applyTerminalSessionRemoved(snapshot: MachineSnapshot, sessionId: string, workspaceId?: string): MachineSnapshot {
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

export function applyAgentSessionUpsert(snapshot: MachineSnapshot, session: MachineAgentSessionRecord): MachineSnapshot {
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

export function applyAgentSessionRemoved(snapshot: MachineSnapshot, sessionId: string, workspaceId: string): MachineSnapshot {
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

export function applyMachineEventToSnapshot(snapshot: MachineSnapshot, event: MachineEvent): MachineSnapshot {
  switch (event.type) {
    case 'snapshot-replaced':
      return event.snapshot;
    case 'workspace-upserted':
      return applyWorkspaceUpsert({ ...snapshot, snapshotNonce: event.snapshotNonce }, event.workspace);
    case 'workspace-removed':
      return applyWorkspaceRemoved({ ...snapshot, snapshotNonce: event.snapshotNonce }, event.workspaceId);
    case 'terminal-session-upserted':
      return applyTerminalSessionUpsert({ ...snapshot, snapshotNonce: event.snapshotNonce }, event.session);
    case 'terminal-session-removed':
      return applyTerminalSessionRemoved({ ...snapshot, snapshotNonce: event.snapshotNonce }, event.sessionId, event.workspaceId);
    case 'agent-session-upserted':
      return applyAgentSessionUpsert({ ...snapshot, snapshotNonce: event.snapshotNonce }, event.session);
    case 'agent-session-removed':
      return applyAgentSessionRemoved({ ...snapshot, snapshotNonce: event.snapshotNonce }, event.sessionId, event.workspaceId);
  }
}
