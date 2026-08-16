import type {
  MachineAgentSessionRecord,
  MachineEvent,
  MachineGoalRecord,
  MachineProcessRecord,
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
  // Agent-kind terminals are excluded from the per-workspace terminal lists —
  // matching the full snapshot build (they surface via agent sessions).
  const terminalSessionIdsByWorkspaceId = session.workspaceId
    ? {
        ...snapshot.terminalSessionIdsByWorkspaceId,
        [session.workspaceId]: session.kind === 'agent'
          ? removeId(snapshot.terminalSessionIdsByWorkspaceId[session.workspaceId] ?? [], session.id)
          : ensureUniqueId(snapshot.terminalSessionIdsByWorkspaceId[session.workspaceId] ?? [], session.id),
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

export function applyProcessUpsert(snapshot: MachineSnapshot, process: MachineProcessRecord): MachineSnapshot {
  return {
    ...snapshot,
    generatedAt: new Date().toISOString(),
    processesById: { ...snapshot.processesById, [process.id]: process },
    processIdsByWorkspaceId: {
      ...snapshot.processIdsByWorkspaceId,
      [process.workspaceId]: ensureUniqueId(snapshot.processIdsByWorkspaceId[process.workspaceId] ?? [], process.id),
    },
  };
}

export function applyProcessRemoved(snapshot: MachineSnapshot, processId: string, workspaceId: string): MachineSnapshot {
  if (!snapshot.processesById[processId]) return snapshot;
  const processesById = { ...snapshot.processesById };
  delete processesById[processId];
  return {
    ...snapshot,
    generatedAt: new Date().toISOString(),
    processesById,
    processIdsByWorkspaceId: {
      ...snapshot.processIdsByWorkspaceId,
      [workspaceId]: removeId(snapshot.processIdsByWorkspaceId[workspaceId] ?? [], processId),
    },
  };
}

export function applyWorkspaceDerivedReplaced(
  snapshot: MachineSnapshot,
  workspaceId: string,
  derived: {
    terminalSessionIds: string[];
    agentSessionIds: string[];
    processIds: string[];
    summary: MachineWorkspaceRecord['summary'];
  },
): MachineSnapshot {
  const existing = snapshot.workspacesById[workspaceId];
  if (!existing) return snapshot;
  return {
    ...snapshot,
    generatedAt: new Date().toISOString(),
    workspacesById: {
      ...snapshot.workspacesById,
      [workspaceId]: {
        ...existing,
        terminalSessionIds: derived.terminalSessionIds,
        agentSessionIds: derived.agentSessionIds,
        processIds: derived.processIds,
        summary: derived.summary,
      },
    },
  };
}

export function applyProjectGoalsReplaced(
  snapshot: MachineSnapshot,
  projectId: string,
  goalsById: Record<string, MachineGoalRecord>,
  goalOrder: string[],
): MachineSnapshot {
  const previousProjectGoalIds = snapshot.goalIdsByProjectId?.[projectId] ?? [];
  const nextGoalsById: Record<string, MachineGoalRecord> = { ...(snapshot.goalsById ?? {}) };
  for (const goalId of previousProjectGoalIds) {
    delete nextGoalsById[goalId];
  }
  for (const [goalId, goal] of Object.entries(goalsById)) {
    nextGoalsById[goalId] = goal;
  }
  // Preserve cross-project positions where possible: keep the other projects'
  // ids in place, drop this project's old ids, append this project's new order.
  const removed = new Set(previousProjectGoalIds);
  const retained = (snapshot.goalOrder ?? []).filter((goalId) => !removed.has(goalId));
  const nextGoalOrder = [...retained, ...goalOrder];
  return {
    ...snapshot,
    generatedAt: new Date().toISOString(),
    goalsById: nextGoalsById,
    goalOrder: nextGoalOrder,
    goalIdsByProjectId: {
      ...(snapshot.goalIdsByProjectId ?? {}),
      [projectId]: [...goalOrder],
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
    case 'process-upserted':
      return applyProcessUpsert({ ...snapshot, snapshotNonce: event.snapshotNonce }, event.process);
    case 'process-removed':
      return applyProcessRemoved({ ...snapshot, snapshotNonce: event.snapshotNonce }, event.processId, event.workspaceId);
    case 'project-goals-replaced':
      return applyProjectGoalsReplaced(
        { ...snapshot, snapshotNonce: event.snapshotNonce },
        event.projectId,
        event.goalsById,
        event.goalOrder,
      );
    case 'workspace-derived-replaced':
      return applyWorkspaceDerivedReplaced(
        { ...snapshot, snapshotNonce: event.snapshotNonce },
        event.workspaceId,
        event,
      );
    default: {
      // Forward compatibility: an unknown event type must never wipe the
      // snapshot. Advance the nonce (the sender consumed one) and keep state.
      const unknown = event as { snapshotNonce?: number };
      return typeof unknown.snapshotNonce === 'number'
        ? { ...snapshot, snapshotNonce: unknown.snapshotNonce }
        : snapshot;
    }
  }
}
