import { normalizeProcessInstanceCount } from '../../../lib/processes/instances.js';
import type { MachineAgentSessionRecord, MachineTerminalSessionRecord } from '../../../lib/tmux-lite/machine/types.js';
import type { MultiMachineState } from '../../../machine/multi/types.js';
import { selectAllWorkspaces } from '../../../machine/multi/selectors.js';
import { getAgentSessionDisplayTitle } from '../../../agents/session-display.js';
import type { AgentSessionInfo, SessionInfo } from '../../../components/SpacesBrowser.js';
import { deriveWorkspaceStatusSummary } from '../../workspaces/workspace-status.js';
import type { WorkspaceRuntimeEntry, WorkspaceRuntimeModel, WorkspaceRuntimeWorkspaceInfo } from './types.js';

function toSessionInfo(session: MachineTerminalSessionRecord): SessionInfo {
  return {
    id: session.id,
    name: session.name,
    workspaceId: session.workspaceId ?? 'unknown',
    attached: session.attached,
    createdAt: session.createdAt,
    processTitle: session.processTitle,
    terminalTitle: session.terminalTitle,
    lastAlertKind: session.lastAlertKind,
    lastAlertPreview: session.lastAlertPreview,
    lastAlertAt: session.lastAlertAt,
    unreadAlertCount: session.unreadAlertCount,
    processName: session.processName,
    processInstance: session.processInstance,
    exitCode: session.exitCode,
  };
}

function toAgentSessionInfo(agent: MachineAgentSessionRecord): AgentSessionInfo {
  return {
    id: agent.id,
    workspaceId: agent.workspaceId,
    title: getAgentSessionDisplayTitle({ id: agent.id, title: agent.title }),
    updatedAt: agent.updatedAt,
    closedAt: agent.closedAt,
    archivedAt: agent.archivedAt,
    status: agent.state === 'running'
      ? { type: 'busy' }
      : agent.state === 'retrying'
        ? { type: 'retry', attempt: 1, message: agent.errorMessage ?? 'retrying', next: Date.now() + 1000 }
        : !agent.closedAt && agent.state !== 'archived'
          ? { type: 'idle' }
          : undefined,
    pendingPermissionCount: agent.pendingPermissionCount,
    errorMessage: agent.errorMessage,
  };
}

export function getSessionSubtitle(session: SessionInfo): string | undefined {
  return session.processTitle ?? session.terminalTitle ?? session.lastAlertPreview ?? undefined;
}

export function getSessionAlertLabel(session: SessionInfo): string | undefined {
  if (!session.lastAlertKind) {
    return undefined;
  }
  return `${session.lastAlertKind}${session.unreadAlertCount ? ` (${session.unreadAlertCount})` : ''}`;
}

function getLatestSession(sessions: SessionInfo[]): SessionInfo | null {
  if (sessions.length === 0) return null;
  return [...sessions].sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

export function deriveWorkspaceRuntimeModel(state: MultiMachineState): WorkspaceRuntimeModel {
  const workspaces: WorkspaceRuntimeWorkspaceInfo[] = selectAllWorkspaces(state).map(({ backendKey, workspace }) => ({
    id: workspace.id,
    name: workspace.name,
    path: workspace.path,
    projectName: workspace.projectName,
    branch: workspace.branch,
    phase: workspace.phase,
    sessionCount: workspace.summary.terminalCount,
    isStale: workspace.isStale,
    processes: workspace.processes,
    serveDomain: workspace.serveDomain,
    processConfigError: workspace.processConfigError,
    notesSummary: workspace.notesSummary,
    pullRequest: workspace.pullRequest,
    linear: workspace.linear,
    backendKey,
    machineLabel: state.byBackend[backendKey]?.label ?? backendKey,
  }));

  const sessions: SessionInfo[] = [];
  const agentSessionsByWorkspace: Record<string, AgentSessionInfo[]> = {};

  for (const backendKey of state.backendOrder) {
    const snapshot = state.byBackend[backendKey]?.snapshot;
    if (!snapshot) continue;
    for (const workspaceId of Object.keys(snapshot.terminalSessionIdsByWorkspaceId)) {
      for (const id of snapshot.terminalSessionIdsByWorkspaceId[workspaceId] ?? []) {
        const session = snapshot.terminalSessionsById[id];
        if (session) {
          sessions.push(toSessionInfo(session));
        }
      }
    }
    for (const workspaceId of Object.keys(snapshot.agentSessionIdsByWorkspaceId)) {
      agentSessionsByWorkspace[workspaceId] = (snapshot.agentSessionIdsByWorkspaceId[workspaceId] ?? [])
        .map((id) => snapshot.agentSessionsById[id])
        .filter(Boolean)
        .map((agent) => toAgentSessionInfo(agent!));
    }
  }

  const agentSessionCounts: Record<string, number> = {};
  const pendingPermissionsByWorkspace: Record<string, number> = {};
  for (const [workspaceId, entries] of Object.entries(agentSessionsByWorkspace)) {
    agentSessionCounts[workspaceId] = entries.filter((session) => !session.closedAt && !session.archivedAt).length;
    pendingPermissionsByWorkspace[workspaceId] = entries.reduce((count, session) => count + (session.pendingPermissionCount ?? 0), 0);
  }

  const workspaceStatusById: WorkspaceRuntimeModel['workspaceStatusById'] = {};
  const stripStatusById: WorkspaceRuntimeModel['stripStatusById'] = {};
  const runtimeByWorkspace: Record<string, WorkspaceRuntimeEntry> = {};

  for (const workspace of workspaces) {
    const workspaceSessions = sessions
      .filter((session) => session.workspaceId === workspace.id)
      .sort((a, b) => {
        const aProcess = a.processName ? 0 : 1;
        const bProcess = b.processName ? 0 : 1;
        if (aProcess !== bProcess) return aProcess - bProcess;
        return a.name.localeCompare(b.name);
      });
    const shellSessions = workspaceSessions.filter((session) => !session.processName);
    const processSessions = workspaceSessions.filter((session) => !!session.processName);
    const sessionRows = shellSessions.map((session) => ({
      id: session.id,
      label: session.name.split(':').pop() ?? session.name,
      attached: session.attached,
      statusLabel: session.attached ? 'attached' as const : 'idle' as const,
      subtitle: getSessionSubtitle(session),
      alertLabel: getSessionAlertLabel(session),
    }));

    const processRows: WorkspaceRuntimeEntry['processRows'] = [];
    for (const process of workspace.processes ?? []) {
      const configuredCount = normalizeProcessInstanceCount(process.instances);
      if (configuredCount === 0) {
        processRows.push({
          key: `${process.name}:disabled`,
          processName: process.name,
          instance: 0,
          label: `${process.name} (disabled)`,
          state: 'disabled',
        });
        continue;
      }
      for (let instance = 1; instance <= configuredCount; instance += 1) {
        const matchingSessions = processSessions.filter(
          (session) => session.processName === process.name && (session.processInstance ?? 1) === instance,
        );
        const runningSession = getLatestSession(matchingSessions.filter((session) => session.exitCode === undefined));
        const latestSession = getLatestSession(matchingSessions);
        const port = (process.ports ?? [])[instance - 1] ?? (process.ports ?? [])[0] ?? null;
        const stateLabel: WorkspaceRuntimeEntry['processRows'][number]['state'] = runningSession
          ? 'running'
          : latestSession?.exitCode !== undefined
            ? (latestSession.exitCode === 0 ? 'stopped' : 'failed')
            : 'stopped';
        const activeSession = runningSession ?? latestSession ?? undefined;
        processRows.push({
          key: `${process.name}:${instance}`,
          processName: process.name,
          instance,
          label: `${process.name}#${instance}`,
          portLabel: port ? `localhost:${port.port}` : undefined,
          state: stateLabel,
          subtitle: activeSession ? getSessionSubtitle(activeSession) : undefined,
          alertLabel: activeSession ? getSessionAlertLabel(activeSession) : undefined,
          attachableSessionId: runningSession?.id,
        });
      }
    }

    const summary = deriveWorkspaceStatusSummary(
      workspace,
      workspaceSessions,
      agentSessionsByWorkspace[workspace.id] ?? [],
    );
    workspaceStatusById[workspace.id] = summary;
    stripStatusById[workspace.id] = { primaryColor: summary.primaryColor };
    runtimeByWorkspace[workspace.id] = {
      workspace,
      sessions: workspaceSessions,
      shellSessions,
      processSessions,
      sessionRows,
      processRows,
      agentSessions: agentSessionsByWorkspace[workspace.id] ?? [],
      agentSessionCount: agentSessionCounts[workspace.id] ?? 0,
      pendingPermissionCount: pendingPermissionsByWorkspace[workspace.id] ?? 0,
      statusSummary: summary,
      stripStatus: { primaryColor: summary.primaryColor },
    };
  }

  return {
    workspaces,
    sessions,
    agentSessionsByWorkspace,
    agentSessionCounts,
    pendingPermissionsByWorkspace,
    workspaceStatusById,
    stripStatusById,
    runtimeByWorkspace,
  };
}
