import type { WorkspaceAgentState } from '../../lib/tmux-lite/agent-event-manager.js';
import type { SessionStatus } from '../../agents/agent-runtime-types.js';
import type { ProjectInfo, SessionInfo, WorkspaceInfo } from '../../lib/remote-session/protocol.js';
import type { MachineSnapshot } from '../../lib/tmux-lite/machine/protocol.js';
import { selectProjects, selectWorkspaces } from './client.js';

export function machineSnapshotToProjects(snapshot: MachineSnapshot): ProjectInfo[] {
  return selectProjects(snapshot).map((project) => ({
    name: project.name,
    repository: project.repository,
    workspaceCount: project.workspaceCount,
    isCurrent: project.isCurrent,
  }));
}

export function machineSnapshotToWorkspaces(snapshot: MachineSnapshot): WorkspaceInfo[] {
  return selectWorkspaces(snapshot).map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    path: workspace.path,
    projectName: workspace.projectName,
    branch: workspace.branch,
    sessionCount: workspace.summary.terminalCount,
    isStale: workspace.isStale,
    serveDomain: workspace.serveDomain,
    processes: workspace.processes,
    processConfigError: workspace.processConfigError,
    status: workspace.phase,
    notesSummary: workspace.notesSummary,
  }));
}

export function machineSnapshotToSessions(snapshot: MachineSnapshot, workspaceId?: string): SessionInfo[] {
  return Object.values(snapshot.terminalSessionsById)
    .filter((session) => !workspaceId || session.workspaceId === workspaceId)
    .filter((session) => session.kind !== 'agent')
    .map((session) => ({
      id: session.id,
      name: session.name,
      workspaceId: session.workspaceId ?? '',
      attached: session.attached,
      createdAt: session.createdAt,
      processTitle: session.processTitle,
      terminalTitle: session.terminalTitle,
      lastAlertKind: session.lastAlertKind,
      lastAlertPreview: session.lastAlertPreview,
      lastAlertAt: session.lastAlertAt,
      unreadAlertCount: session.unreadAlertCount,
      exitCode: session.exitCode,
      processName: session.processName,
      processInstance: session.processInstance,
    }));
}

export function machineSnapshotToAgentState(snapshot: MachineSnapshot): Record<string, WorkspaceAgentState> {
  const result: Record<string, WorkspaceAgentState> = {};
  for (const workspace of Object.values(snapshot.workspacesById)) {
    const sessions = (snapshot.agentSessionIdsByWorkspaceId[workspace.id] ?? [])
      .map((id) => snapshot.agentSessionsById[id])
      .filter(Boolean)
      .filter((session) => session.state !== 'archived')
      .map((session) => ({
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        closedAt: session.closedAt,
      }));

    const statuses: WorkspaceAgentState['statuses'] = {};
    const pendingPermissions: WorkspaceAgentState['pendingPermissions'] = {};
    const lastMessages: WorkspaceAgentState['lastMessages'] = {};
    const errorMessages: WorkspaceAgentState['errorMessages'] = {};
    const todoPhases: WorkspaceAgentState['todoPhases'] = {};
    const modelInfo: WorkspaceAgentState['modelInfo'] = {};
    const queuedMessages: WorkspaceAgentState['queuedMessages'] = {};

    for (const sessionId of snapshot.agentSessionIdsByWorkspaceId[workspace.id] ?? []) {
      const session = snapshot.agentSessionsById[sessionId];
      if (!session || session.state === 'archived') continue;
      let status: SessionStatus | undefined;
      switch (session.state) {
        case 'running':
          status = { type: 'busy' };
          break;
        case 'retrying':
          status = { type: 'retry', attempt: 1, message: session.errorMessage ?? 'retrying', next: Date.now() + 1000 };
          break;
        case 'waiting':
        case 'permission-needed':
          status = { type: 'idle' };
          break;
      }
      if (status) {
        statuses[session.id] = status;
      }
      if (session.pendingPermissionCount > 0) {
        pendingPermissions[session.id] = session.pendingPermissionIds.map((permissionId) => ({
          id: permissionId,
          type: 'permission',
          sessionID: session.id,
          messageID: '',
          title: 'Permission needed',
          metadata: {},
          time: { created: Date.now() },
        }));
      }
      if (session.lastMessagePreview) {
        lastMessages[session.id] = session.lastMessagePreview;
      }
      if (session.errorMessage) {
        errorMessages[session.id] = session.errorMessage;
      }
      if (session.todoPhases && session.todoPhases.length > 0) {
        todoPhases[session.id] = session.todoPhases;
      }
      if (session.modelInfo) {
        modelInfo[session.id] = session.modelInfo;
      }
      if (session.queuedMessages && (session.queuedMessages.steering.length > 0 || session.queuedMessages.followUp.length > 0)) {
        queuedMessages[session.id] = session.queuedMessages;
      }
    }

    result[workspace.id] = {
      workspaceId: workspace.id,
      sessions,
      statuses,
      pendingPermissions,
      pendingQuestions: {},
      lastMessages,
      errorMessages,
      todoPhases,
      modelInfo,
      queuedMessages,
    };
  }
  return result;
}

export function machineSnapshotToKnownAgentSessions(
  snapshot: MachineSnapshot,
  workspaceId: string,
  options: { includeArchived: boolean },
): Array<{ id: string; title: string; updatedAt?: string; closedAt?: string; archivedAt?: string }> {
  return (snapshot.agentSessionIdsByWorkspaceId[workspaceId] ?? [])
    .map((id) => snapshot.agentSessionsById[id])
    .filter(Boolean)
    .filter((session) => options.includeArchived || session.state !== 'archived')
    .map((session) => ({
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
      closedAt: session.closedAt,
      archivedAt: session.archivedAt,
    }));
}
