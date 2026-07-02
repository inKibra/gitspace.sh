import type { Session, WorkspaceRuntimeRecord } from './protocol.js';
import type { WorkspaceAgentState } from './agent-event-manager.js';
import { scanWorkspaces } from '../remote-session/workspace-scanner.js';
import { loadProcessesConfigWithDiagnostics } from '../processes/config.js';
import { resolveRuntimeProcesses } from '../processes/allocations.js';
import { parseProcessSessionName } from '../processes/names.js';
import { toCanonicalWorkspaceId } from '../../utils/workspace-id.js';
import { getArchivedSessions } from '../../agents/agent-db.js';

function summarizeWorkspaceTerminals(workspacePath: string, sessions: Session[]) {
  const relevant = sessions.filter(
    (session) => session.cwd === workspacePath && !(session.hidden || session.kind === 'agent'),
  );
  return {
    sessionCount: relevant.length,
    attachedCount: relevant.filter((session) => session.attached).length,
    runningCount: relevant.filter((session) => session.exitCode === undefined).length,
    failedCount: relevant.filter((session) => session.exitCode !== undefined && session.exitCode !== 0).length,
  };
}

function summarizeWorkspaceProcesses(
  sessions: Session[],
  workspaceId: string,
  workspaceName: string,
  workspacePath: string,
  configuredCount: number,
) {
  const relevant = sessions.filter(
    (session) => {
      const parsed = parseProcessSessionName(session.name);
      return (
        (session.metadata?.workspaceId === workspaceId && !!session.metadata?.processName) ||
        (parsed?.workspaceId === workspaceName && !!parsed.processName) ||
        (session.cwd.startsWith(workspacePath) && !!parsed?.processName)
      );
    },
  );
  return {
    configuredCount,
    runningCount: relevant.filter((session) => session.exitCode === undefined).length,
    failedCount: relevant.filter((session) => session.exitCode !== undefined && session.exitCode !== 0).length,
  };
}

function summarizeWorkspaceAgents(
  workspaceId: string,
  agentState: WorkspaceAgentState | undefined,
) {
  // Counts derived from the in-memory snapshot and the archived sessions db.
  const closedCount = (agentState?.sessions ?? []).filter((s) => !!s.closedAt).length;
  const archivedCount = getArchivedSessions(workspaceId).length;

  if (!agentState) {
    return {
      sessionCount: 0,
      busyCount: 0,
      waitingCount: 0,
      needsPermissionCount: 0,
      errorCount: 0,
      closedCount,
      archivedCount,
    };
  }

  let busyCount = 0;
  let waitingCount = 0;
  let errorCount = 0;
  let needsPermissionCount = 0;

  for (const session of agentState.sessions) {
    if (session.closedAt) continue;
    const status = agentState.statuses[session.id];
    const pending = agentState.pendingPermissions[session.id] ?? [];
    const pendingQ = agentState.pendingQuestions[session.id] ?? [];
    if (pending.length > 0 || pendingQ.length > 0) {
      needsPermissionCount += 1;
      continue;
    }
    if (status?.type === 'retry') {
      errorCount += 1;
      continue;
    }
    if (status?.type === 'busy') {
      busyCount += 1;
      continue;
    }
    waitingCount += 1;
  }

  return {
    sessionCount: agentState.sessions.length,
    busyCount,
    waitingCount,
    needsPermissionCount,
    errorCount,
    closedCount,
    archivedCount,
  };
}

export async function getWorkspaceRuntimeSnapshot(params: {
  sessions: Session[];
  agentStateByWorkspaceId: Record<string, WorkspaceAgentState>;
}): Promise<WorkspaceRuntimeRecord[]> {
  const { sessions, agentStateByWorkspaceId } = params;
  const workspaces = await scanWorkspaces();

  return Promise.all(workspaces.map(async (workspace) => {
    const workspaceId = toCanonicalWorkspaceId(workspace);
    const processConfig = loadProcessesConfigWithDiagnostics(workspace.path);
    // probe:false — a machine snapshot must not run lsof per port (it can block
    // the single-threaded server for seconds each); report allocated ports from
    // state, liveness comes from tmux-lite sessions.
    const processes = await resolveRuntimeProcesses(workspace.path, processConfig.config, { probe: false });
    const terminals = summarizeWorkspaceTerminals(workspace.path, sessions);
    const agents = summarizeWorkspaceAgents(workspaceId, agentStateByWorkspaceId[workspaceId]);
    const processSummary = summarizeWorkspaceProcesses(sessions, workspaceId, workspace.id, workspace.path, processes.length);

    return {
      ...workspace,
      id: workspaceId,
      sessionCount: terminals.sessionCount,
      processes,
      processConfigError: processConfig.error ?? undefined,
      terminals,
      agents,
      processSummary,
    } satisfies WorkspaceRuntimeRecord;
  }));
}
