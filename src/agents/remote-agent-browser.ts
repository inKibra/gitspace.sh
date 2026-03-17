export interface AgentBrowserWorkspaceRef {
  id: string;
}

export interface AgentBrowserSnapshot {
  sessions: Array<{ id: string }>;
}

export function collectAgentSessionCounts(options: {
  sessionsByWorkspace: Record<string, Array<{ id: string }>>;
  workspaceStates: Record<string, Record<string, unknown>>;
  snapshotByWorkspace: Record<string, AgentBrowserSnapshot>;
}): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const [workspaceId, sessions] of Object.entries(options.sessionsByWorkspace)) {
    counts[workspaceId] = Math.max(counts[workspaceId] ?? 0, sessions.length);
  }

  for (const [workspaceId, sessions] of Object.entries(options.workspaceStates)) {
    counts[workspaceId] = Math.max(counts[workspaceId] ?? 0, Object.keys(sessions).length);
  }

  for (const [workspaceId, snapshot] of Object.entries(options.snapshotByWorkspace)) {
    counts[workspaceId] = Math.max(counts[workspaceId] ?? 0, snapshot.sessions.length);
  }

  return counts;
}

export function collectWorkspaceSyncIds(
  workspaces: AgentBrowserWorkspaceRef[],
  expandedWorkspaceIds: string[] = [],
  selectedWorkspaceId: string | null = null,
): string[] {
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));

  for (const workspaceId of expandedWorkspaceIds) {
    workspaceIds.add(workspaceId);
  }

  if (selectedWorkspaceId) {
    workspaceIds.add(selectedWorkspaceId);
  }

  return Array.from(workspaceIds);
}
