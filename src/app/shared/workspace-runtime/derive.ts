import { normalizeProcessInstanceCount } from '../../../lib/processes/instances.js';
import type { MachineAgentSessionRecord, MachineTerminalSessionRecord } from '../../../lib/tmux-lite/machine/types.js';
import type { MultiMachineState } from '../../../machine/multi/types.js';
import { toBackendScopedWorkspaceKey } from '../../../machine/multi/types.js';
import { selectAllWorkspaces } from '../../../machine/multi/selectors.js';
import { getAgentSessionDisplayTitle } from '../../../agents/session-display.js';
import { sessionStatusFromActivity } from '../../../agents/agent-runtime-types.js';
import type { AgentSessionInfo, SessionInfo } from '../../../components/SpacesBrowser.js';
import { deriveWorkspaceStatusSummary } from '../../workspaces/workspace-status.js';
import type { WorkspaceRuntimeEntry, WorkspaceRuntimeModel, WorkspaceRuntimeWorkspaceInfo } from './types.js';
import { getPrimaryProcessPort } from '../../../lib/processes/runtime-ports.js';
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
  // Derive from the shipped activity when present; the `state` inversion below
  // is only a fallback for a daemon that predates it, and is lossy (it turns a
  // human-blocked session into `idle` and hides `compacting`).
  const status = sessionStatusFromActivity(agent.activity, agent.errorMessage)
    ?? (agent.state === 'running'
      ? { type: 'busy' as const }
      : agent.state === 'retrying'
        ? { type: 'retry' as const, attempt: 1, message: agent.errorMessage ?? 'retrying', next: Date.now() + 1000 }
        : agent.state === 'waiting' || agent.state === 'permission-needed'
          ? { type: 'idle' as const }
          : undefined);

  return {
    id: agent.id,
    workspaceId: agent.workspaceId,
    title: getAgentSessionDisplayTitle({ id: agent.id, title: agent.title }),
    updatedAt: agent.updatedAt,
    closedAt: agent.closedAt,
    dormantSince: agent.dormantSince,
    archivedAt: agent.archivedAt,
    status,
    activity: agent.activity,
    pendingPermissionCount: agent.pendingPermissionCount,
    pendingQuestionCount: agent.pendingQuestionCount,
    errorMessage: agent.errorMessage,
    modelInfo: agent.modelInfo,
    todoPhases: agent.todoPhases,
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
    selectionKey: toBackendScopedWorkspaceKey({ backendKey, workspaceId: workspace.id }),
  }));

  const sessions: SessionInfo[] = [];
  const agentSessionsByWorkspace: Record<string, AgentSessionInfo[]> = {};

  const toWorkspaceMapKey = (backendKey: string, workspaceId: string): string =>
    toBackendScopedWorkspaceKey({ backendKey, workspaceId });

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
      const mapKey = toWorkspaceMapKey(backendKey, workspaceId);
      agentSessionsByWorkspace[mapKey] = (snapshot.agentSessionIdsByWorkspaceId[workspaceId] ?? [])
        .map((id) => snapshot.agentSessionsById[id])
        .filter(Boolean)
        .map((agent) => toAgentSessionInfo(agent!));
    }
  }

  const agentSessionCounts: Record<string, number> = {};
  const pendingPermissionsByWorkspace: Record<string, number> = {};
  for (const [workspaceKey, entries] of Object.entries(agentSessionsByWorkspace)) {
    const activeEntries = entries.filter((session) => !session.closedAt && !session.archivedAt);
    agentSessionCounts[workspaceKey] = activeEntries.length;
    pendingPermissionsByWorkspace[workspaceKey] = entries.reduce(
      (count, session) => count + (session.pendingPermissionCount ?? 0),
      0,
    );
  }

  const workspaceStatusById: WorkspaceRuntimeModel['workspaceStatusById'] = {};
  const stripStatusById: WorkspaceRuntimeModel['stripStatusById'] = {};
  const runtimeByWorkspace: Record<string, WorkspaceRuntimeEntry> = {};

  for (const workspace of workspaces) {
    const snapshot = state.byBackend[workspace.backendKey]?.snapshot;
    const workspaceLookupKey = toWorkspaceMapKey(workspace.backendKey, workspace.id);
    const workspaceSessions = (snapshot?.terminalSessionIdsByWorkspaceId[workspace.id] ?? [])
      .map((id) => snapshot?.terminalSessionsById[id])
      .filter(Boolean)
      .map((session) => toSessionInfo(session!))
      .sort((a, b) => {
        const aProcess = a.processName ? 0 : 1;
        const bProcess = b.processName ? 0 : 1;
        if (aProcess !== bProcess) return aProcess - bProcess;
        return a.name.localeCompare(b.name);
      });
    const workspaceAgentSessions = agentSessionsByWorkspace[workspaceLookupKey] ?? [];
    const agentSessionCount = workspaceAgentSessions.filter((session) => !session.closedAt && !session.archivedAt).length;
    const pendingPermissionCount = workspaceAgentSessions.reduce(
      (count, session) => count + (session.pendingPermissionCount ?? 0),
      0,
    );
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
        const port = getPrimaryProcessPort(process.ports, instance);
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
      workspaceAgentSessions,
    );
    workspaceStatusById[workspace.selectionKey] = summary;
    stripStatusById[workspace.selectionKey] = { primaryColor: summary.primaryColor };
    runtimeByWorkspace[workspace.selectionKey] = {
      workspace,
      sessions: workspaceSessions,
      shellSessions,
      processSessions,
      sessionRows,
      processRows,
      agentSessions: workspaceAgentSessions,
      agentSessionCount,
      pendingPermissionCount,
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
