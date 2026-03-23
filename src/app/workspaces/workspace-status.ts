import { normalizeProcessInstanceCount } from '../../lib/processes/instances.js';
import type { AgentSessionInfo, SessionInfo } from '../../machine/api/list-types.js';

/** Minimal workspace shape needed to compute status summaries. */
export interface WorkspaceStatusInput {
  id: string;
  processes?: { name: string; instances?: number }[];
  processConfigError?: string;
}

export type WorkspaceStatusColor = 'dim' | 'green' | 'blue' | 'orange' | 'red';

export interface WorkspaceStatusCounts {
  green: number;
  blue: number;
  orange: number;
  red: number;
}

export interface WorkspaceStatusSummary {
  primaryColor: WorkspaceStatusColor;
  agents: WorkspaceStatusCounts;
  services: Pick<WorkspaceStatusCounts, 'green' | 'red'>;
  terminals: Pick<WorkspaceStatusCounts, 'green' | 'red'>;
}

export interface MachineWorkspaceSummaryInput {
  permissionAgentCount: number;
  retryingAgentCount: number;
  failedProcessCount: number;
  failedTerminalCount: number;
  waitingAgentCount: number;
  runningAgentCount: number;
  runningProcessCount: number;
}

const ACTIONABLE_AGENT_ERROR_PATTERNS = [
  /credit|credits|quota|billing/i,
  /rate\s*limit|429/i,
  /api\s*key|unauthori[sz]ed|forbidden|authentication/i,
  /provider|model|openai|anthropic|gemini/i,
  /network|connection|timeout/i,
];

const NOISY_AGENT_ERROR_PATTERNS = [
  /\blsp\b/i,
  /language\s+server/i,
];

function isActionableAgentError(message: string | undefined): boolean {
  if (!message) {
    return false;
  }
  if (NOISY_AGENT_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
    return false;
  }
  return ACTIONABLE_AGENT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function getLatestSession(sessions: SessionInfo[]): SessionInfo | null {
  if (sessions.length === 0) {
    return null;
  }
  return [...sessions].sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

export function deriveWorkspaceStatusSummary(
  workspace: WorkspaceStatusInput,
  sessions: SessionInfo[],
  agentSessions: AgentSessionInfo[],
): WorkspaceStatusSummary {
  const agents: WorkspaceStatusCounts = { green: 0, blue: 0, orange: 0, red: 0 };
  const services = { green: 0, red: 0 };
  const terminals = { green: 0, red: 0 };

  for (const agent of agentSessions) {
    if (agent.archivedAt || agent.closedAt) {
      continue;
    }
    if ((agent.pendingPermissionCount ?? 0) > 0) {
      agents.orange += 1;
      continue;
    }
    if (agent.status?.type === 'retry' || isActionableAgentError(agent.errorMessage)) {
      agents.red += 1;
      continue;
    }
    if (agent.status?.type === 'busy') {
      agents.green += 1;
      continue;
    }
    agents.blue += 1;
  }

  for (const session of sessions) {
    if (session.exitCode === undefined) {
      terminals.green += 1;
    } else if (session.exitCode !== 0) {
      terminals.red += 1;
    }
  }

  for (const process of workspace.processes ?? []) {
    const configuredCount = normalizeProcessInstanceCount(process.instances);
    for (let instance = 1; instance <= configuredCount; instance += 1) {
      const matchingSessions = sessions.filter(
        (session) => session.processName === process.name && (session.processInstance ?? 1) === instance,
      );
      const runningSession = getLatestSession(
        matchingSessions.filter((session) => session.exitCode === undefined),
      );
      const latestSession = getLatestSession(matchingSessions);
      if (runningSession) {
        services.green += 1;
      } else if (latestSession?.exitCode !== undefined && latestSession.exitCode !== 0) {
        services.red += 1;
      }
    }
  }

  if (workspace.processConfigError) {
    services.red += 1;
  }

  let primaryColor: WorkspaceStatusColor = 'dim';
  if (agents.orange > 0) {
    primaryColor = 'orange';
  } else if (agents.red > 0 || services.red > 0 || terminals.red > 0) {
    primaryColor = 'red';
  } else if (agents.blue > 0) {
    primaryColor = 'blue';
  } else if (agents.green > 0 || services.green > 0) {
    primaryColor = 'green';
  }

  return {
    primaryColor,
    agents,
    services,
    terminals,
  };
}

export function buildWorkspaceStatusSummaryMap(
  workspaces: WorkspaceStatusInput[],
  sessions: SessionInfo[],
  agentSessionsByWorkspace: Record<string, AgentSessionInfo[]>,
): Record<string, WorkspaceStatusSummary> {
  const byWorkspaceId: Record<string, SessionInfo[]> = {};
  for (const session of sessions) {
    const current = byWorkspaceId[session.workspaceId] ?? [];
    current.push(session);
    byWorkspaceId[session.workspaceId] = current;
  }

  const result: Record<string, WorkspaceStatusSummary> = {};
  for (const workspace of workspaces) {
    result[workspace.id] = deriveWorkspaceStatusSummary(
      workspace,
      byWorkspaceId[workspace.id] ?? [],
      agentSessionsByWorkspace[workspace.id] ?? [],
    );
  }
  return result;
}

export function deriveWorkspacePrimaryColorFromMachineSummary(
  summary: MachineWorkspaceSummaryInput,
): WorkspaceStatusColor {
  if (summary.permissionAgentCount > 0) {
    return 'orange';
  }
  if (summary.retryingAgentCount > 0 || summary.failedProcessCount > 0 || summary.failedTerminalCount > 0) {
    return 'red';
  }
  if (summary.waitingAgentCount > 0) {
    return 'blue';
  }
  if (summary.runningAgentCount > 0 || summary.runningProcessCount > 0) {
    return 'green';
  }
  return 'dim';
}
