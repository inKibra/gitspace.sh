import { listProjectSummaries } from '../../../core/project-catalog.js';
import { getArchivedSessions } from '../../../agents/agent-db.js';
import type { WorkspaceAgentState } from '../agent-event-manager.js';
import type { Session, WorkspaceRuntimeRecord } from '../protocol.js';
import { parseProcessSessionName } from '../../processes/names.js';
import type {
  MachineAgentSessionRecord,
  MachineProcessRecord,
  MachineProjectRecord,
  MachineSnapshot,
  MachineTerminalSessionRecord,
  MachineWorkspaceRecord,
} from './types.js';
import { getWorkspacePmSnapshot } from './pm-links.js';

function determineTerminalState(session: Session): MachineTerminalSessionRecord['state'] {
  if (session.attached) return 'attached';
  if (session.exitCode === undefined) return 'running';
  if (session.exitCode === 0) return 'exited';
  return 'failed';
}

function determineAgentState(
  workspace: WorkspaceAgentState,
  sessionId: string,
  closedAt: string | undefined,
  errorMessage: string | undefined,
  pendingQuestionCount: number,
  pendingPermissionCount: number,
): MachineAgentSessionRecord['state'] {
  if (closedAt) return 'closed';
  if (pendingPermissionCount > 0 || pendingQuestionCount > 0) return 'permission-needed';
  const status = workspace.statuses[sessionId];
  if (status?.type === 'retry' || errorMessage) return 'retrying';
  if (status?.type === 'busy') return 'running';
  return 'waiting';
}


function resolveWorkspaceIdForTerminal(
  session: Session,
  workspacesById: Record<string, MachineWorkspaceRecord>,
): string | undefined {
  const metadataWorkspaceId = session.metadata?.workspaceId;
  if (metadataWorkspaceId && workspacesById[metadataWorkspaceId]) {
    return metadataWorkspaceId;
  }
  const parsed = parseProcessSessionName(session.name);
  if (parsed?.workspaceId) {
    const match = Object.values(workspacesById).find(
      (workspace) => workspace.id === parsed.workspaceId || workspace.name === parsed.workspaceId,
    );
    if (match) {
      return match.id;
    }
  }
  const match = Object.values(workspacesById).find((workspace) => workspace.path === session.cwd);
  return match?.id;
}

function getProcessIdentity(session: Session): { processName?: string; processInstance?: number } {
  const parsed = parseProcessSessionName(session.name);
  return {
    processName: session.metadata?.processName ?? parsed?.processName,
    processInstance: session.metadata?.processInstance
      ? Number(session.metadata.processInstance)
      : parsed?.instance,
  };
}

function cloneWorkspaceRecord(workspace: WorkspaceRuntimeRecord): MachineWorkspaceRecord {
  return {
    id: workspace.id,
    name: workspace.name,
    projectId: workspace.projectName,
    projectName: workspace.projectName,
    path: workspace.path,
    branch: workspace.branch,
    phase: workspace.status,
    isStale: workspace.isStale,
    serveDomain: workspace.serveDomain,
    processes: workspace.processes,
    processConfigError: workspace.processConfigError,
    notesSummary: workspace.notesSummary,
    terminalSessionIds: [],
    agentSessionIds: [],
    processIds: [],
    replayIds: [],
    summary: {
      terminalCount: workspace.terminals.sessionCount,
      attachedTerminalCount: workspace.terminals.attachedCount,
      runningTerminalCount: workspace.terminals.runningCount,
      failedTerminalCount: workspace.terminals.failedCount,
      agentCount: workspace.agents.sessionCount,
      runningAgentCount: workspace.agents.busyCount,
      waitingAgentCount: workspace.agents.waitingCount,
      permissionAgentCount: workspace.agents.needsPermissionCount,
      retryingAgentCount: workspace.agents.errorCount,
      closedAgentCount: workspace.agents.closedCount,
      archivedAgentCount: workspace.agents.archivedCount,
      configuredProcessCount: workspace.processSummary.configuredCount,
      runningProcessCount: workspace.processSummary.runningCount,
      failedProcessCount: workspace.processSummary.failedCount,
    },
  };
}

export function buildMachineSnapshot(params: {
  snapshotNonce: number;
  terminalSessions: Session[];
  workspaces: WorkspaceRuntimeRecord[];
  agentStateByWorkspaceId: Record<string, WorkspaceAgentState>;
}): MachineSnapshot {
  const { snapshotNonce, terminalSessions, workspaces, agentStateByWorkspaceId } = params;

  const projectsById: Record<string, MachineProjectRecord> = {};
  const projectOrder: string[] = [];
  const workspaceIdsByProjectId: Record<string, string[]> = {};

  for (const project of listProjectSummaries()) {
    projectsById[project.name] = {
      id: project.name,
      name: project.name,
      repository: project.repository,
      isCurrent: project.isCurrent,
      workspaceIds: [],
      workspaceCount: project.workspaceCount,
    };
    projectOrder.push(project.name);
    workspaceIdsByProjectId[project.name] = [];
  }

  const workspacesById: Record<string, MachineWorkspaceRecord> = {};
  const workspaceOrder: string[] = [];
  const workspacePmSnapshot = getWorkspacePmSnapshot(workspaces);

  for (const workspace of workspaces) {
    const record = cloneWorkspaceRecord(workspace);
    const pmState = workspacePmSnapshot[workspace.id];
    if (pmState) {
      record.pullRequest = pmState.pullRequest;
      record.linear = pmState.linear;
    }
    workspacesById[record.id] = record;
    workspaceOrder.push(record.id);
    workspaceIdsByProjectId[record.projectId] = [...(workspaceIdsByProjectId[record.projectId] ?? []), record.id];
    if (projectsById[record.projectId]) {
      projectsById[record.projectId] = {
        ...projectsById[record.projectId],
        workspaceIds: [...projectsById[record.projectId].workspaceIds, record.id],
      };
    }
  }

  const terminalSessionsById: Record<string, MachineTerminalSessionRecord> = {};
  const terminalSessionIdsByWorkspaceId: Record<string, string[]> = {};
  const processesById: Record<string, MachineProcessRecord> = {};
  const processIdsByWorkspaceId: Record<string, string[]> = {};

  for (const session of terminalSessions) {
    const workspaceId = resolveWorkspaceIdForTerminal(session, workspacesById);
    const projectId = workspaceId ? workspacesById[workspaceId]?.projectId : undefined;
    const processIdentity = getProcessIdentity(session);
    const terminalRecord: MachineTerminalSessionRecord = {
      id: session.id,
      name: session.name,
      workspaceId,
      projectId,
      cwd: session.cwd,
      kind: session.kind === 'agent'
        ? 'agent-pty'
        : processIdentity.processName
          ? 'process'
          : 'shell',
      hidden: session.hidden === true,
      state: determineTerminalState(session),
      attached: session.attached,
      createdAt: session.createdAt,
      exitCode: session.exitCode,
      processTitle: session.processTitle,
      terminalTitle: session.terminalTitle,
      lastAlertKind: session.lastAlertKind,
      lastAlertPreview: session.lastAlertPreview,
      lastAlertAt: session.lastAlertAt,
      unreadAlertCount: session.unreadAlertCount,
      processName: processIdentity.processName,
      processInstance: processIdentity.processInstance,
      linkedAgentSessionId: session.metadata?.agentSessionId,
      metadata: session.metadata,
    };
    terminalSessionsById[session.id] = terminalRecord;
    if (workspaceId && terminalRecord.kind !== 'agent-pty') {
      terminalSessionIdsByWorkspaceId[workspaceId] = [
        ...(terminalSessionIdsByWorkspaceId[workspaceId] ?? []),
        session.id,
      ];
      workspacesById[workspaceId] = {
        ...workspacesById[workspaceId],
        terminalSessionIds: [...workspacesById[workspaceId].terminalSessionIds, session.id],
      };
      if (terminalRecord.processName) {
        const processId = `${workspaceId}:${terminalRecord.processName}:${terminalRecord.processInstance ?? 1}`;
        const nextStatus: MachineProcessRecord['status'] = session.exitCode === undefined
          ? 'running'
          : session.exitCode === 0
            ? 'stopped'
            : 'failed';
        const existing = processesById[processId];
        processesById[processId] = {
          id: processId,
          workspaceId,
          projectId: projectId ?? workspacesById[workspaceId]?.projectId ?? '',
          name: terminalRecord.processName,
          instance: terminalRecord.processInstance,
          status: existing?.status === 'running' ? existing.status : nextStatus,
          terminalSessionId: session.id,
          errorMessage: nextStatus === 'failed' ? `Exit ${session.exitCode}` : undefined,
        };
        processIdsByWorkspaceId[workspaceId] = [
          ...(processIdsByWorkspaceId[workspaceId] ?? []).filter((id) => id !== processId),
          processId,
        ];
        workspacesById[workspaceId] = {
          ...workspacesById[workspaceId],
          processIds: [...workspacesById[workspaceId].processIds.filter((id) => id !== processId), processId],
        };
      }
    }
  }

  const agentSessionsById: Record<string, MachineAgentSessionRecord> = {};
  const agentSessionIdsByWorkspaceId: Record<string, string[]> = {};

  for (const [workspaceId, workspace] of Object.entries(agentStateByWorkspaceId)) {
    const workspaceRecord = workspacesById[workspaceId];
    if (!workspaceRecord) continue;
    for (const session of workspace.sessions) {
      const pendingPermissionIds = (workspace.pendingPermissions[session.id] ?? []).map((permission) => permission.id);
      const pendingQuestionIds = (workspace.pendingQuestions[session.id] ?? []).map((q) => q.id);
      const linkedTerminal = Object.values(terminalSessionsById).find(
        (terminal) => terminal.workspaceId === workspaceId && terminal.linkedAgentSessionId === session.id,
      );
      const errorMessage = workspace.errorMessages[session.id]
        ?? (workspace.statuses[session.id]?.type === 'retry' ? 'retrying' : undefined);
      const record: MachineAgentSessionRecord = {
        id: session.id,
        workspaceId,
        projectId: workspaceRecord.projectId,
        title: session.title,
        state: determineAgentState(
          workspace,
          session.id,
          session.closedAt,
          errorMessage,
          pendingQuestionIds.length,
          pendingPermissionIds.length,
        ),
        updatedAt: session.updatedAt,
        closedAt: session.closedAt,
        pendingPermissionIds,
        pendingPermissionCount: pendingPermissionIds.length,
        pendingQuestionIds,
        pendingQuestionCount: pendingQuestionIds.length,
        errorMessage,
        lastMessagePreview: workspace.lastMessages[session.id],
        linkedTerminalSessionId: linkedTerminal?.id,
        modelInfo: workspace.modelInfo?.[session.id],
        todoPhases: workspace.todoPhases?.[session.id],
      };
      agentSessionsById[record.id] = record;
      agentSessionIdsByWorkspaceId[workspaceId] = [...(agentSessionIdsByWorkspaceId[workspaceId] ?? []), record.id];
      workspacesById[workspaceId] = {
        ...workspacesById[workspaceId],
        agentSessionIds: [...workspacesById[workspaceId].agentSessionIds, record.id],
      };
    }

      for (const archived of getArchivedSessions(workspaceId)) {
        if (agentSessionsById[archived.sessionId]) continue;
        const record: MachineAgentSessionRecord = {
          id: archived.sessionId,
          workspaceId,
          projectId: workspaceRecord.projectId,
          title: archived.title,
          state: 'archived',
          archivedAt: archived.archivedAt,
          pendingPermissionIds: [],
          pendingPermissionCount: 0,
          pendingQuestionIds: [],
          pendingQuestionCount: 0,
        };
      agentSessionsById[record.id] = record;
      agentSessionIdsByWorkspaceId[workspaceId] = [...(agentSessionIdsByWorkspaceId[workspaceId] ?? []), record.id];
      workspacesById[workspaceId] = {
        ...workspacesById[workspaceId],
        agentSessionIds: [...workspacesById[workspaceId].agentSessionIds, record.id],
      };
    }
  }

  for (const [workspaceId, workspaceRecord] of Object.entries(workspacesById)) {
    const agentIds = agentSessionIdsByWorkspaceId[workspaceId] ?? [];
    let runningAgentCount = 0;
    let waitingAgentCount = 0;
    let permissionAgentCount = 0;
    let retryingAgentCount = 0;
    let closedAgentCount = 0;
    let archivedAgentCount = 0;

    for (const agentId of agentIds) {
      const agent = agentSessionsById[agentId];
      if (!agent) continue;
      switch (agent.state) {
        case 'running':
          runningAgentCount += 1;
          break;
        case 'waiting':
          waitingAgentCount += 1;
          break;
        case 'permission-needed':
          permissionAgentCount += 1;
          break;
        case 'retrying':
          retryingAgentCount += 1;
          break;
        case 'closed':
          closedAgentCount += 1;
          break;
        case 'archived':
          archivedAgentCount += 1;
          break;
      }
    }

    workspacesById[workspaceId] = {
      ...workspaceRecord,
      summary: {
        ...workspaceRecord.summary,
        agentCount: agentIds.length,
        runningAgentCount,
        waitingAgentCount,
        permissionAgentCount,
        retryingAgentCount,
        closedAgentCount,
        archivedAgentCount,
      },
    };
  }

  return {
    snapshotNonce,
    generatedAt: new Date().toISOString(),
    projectsById,
    projectOrder,
    workspacesById,
    workspaceOrder,
    workspaceIdsByProjectId,
    terminalSessionsById,
    terminalSessionIdsByWorkspaceId,
    agentSessionsById,
    agentSessionIdsByWorkspaceId,
    processesById,
    processIdsByWorkspaceId,
    replaysById: {},
    replayIdsByWorkspaceId: {},
    notificationsById: {},
    notificationOrder: [],
  };
}
