import { normalizeProcessInstanceCount } from '../../lib/processes/instances.js';
import type { AgentSessionInfo, SessionInfo } from '../../machine/api/list-types.js';

/** Minimal workspace shape needed to compute status summaries. */
export interface WorkspaceStatusInput {
  id: string;
  selectionKey?: string;
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

  // Count the state the record already carries. This used to re-derive it from
  // activity/status/closedAt with its own precedence ladder, which drifted: it
  // never checked dormantSince, so every session merely discovered on disk fell
  // through to blue and made its whole workspace look busy — and sort above
  // genuinely running ones in the detail strip.
  for (const agent of agentSessions) {
    switch (agent.state ?? 'waiting') {
      case 'archived':
      case 'closed':
      case 'dormant':
        // Not live. Contributes nothing, so a workspace whose only sessions are
        // dormant reads 'dim' and drops out of the strip instead of crowding it.
        break;
      case 'permission-needed':
        agents.orange += 1;
        break;
      case 'retrying':
        // A retry counts red only for an error worth acting on. determineAgentState
        // maps ANY errorMessage to 'retrying', so without this filter a noisy LSP
        // message would paint the whole workspace red. This is a noise filter at
        // the workspace level, not a second opinion about the session's state —
        // the session itself still reads 'retrying' on its own row.
        if (agent.errorMessage && !isActionableAgentError(agent.errorMessage)) {
          agents.blue += 1;
        } else {
          agents.red += 1;
        }
        break;
      case 'running':
        agents.green += 1;
        break;
      case 'waiting':
        agents.blue += 1;
        break;
    }
  }

  for (const session of sessions) {
    if (session.processName) {
      continue;
    }
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
  } else if (agents.green > 0) {
    primaryColor = 'green';
  } else if (agents.blue > 0) {
    primaryColor = 'blue';
  } else if (agents.red > 0 || services.red > 0 || terminals.red > 0) {
    primaryColor = 'red';
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
    const workspaceKey = workspace.selectionKey ?? workspace.id;
    result[workspace.id] = deriveWorkspaceStatusSummary(
      workspace,
      byWorkspaceId[workspace.id] ?? [],
      agentSessionsByWorkspace[workspaceKey] ?? [],
    );
  }
  return result;
}

