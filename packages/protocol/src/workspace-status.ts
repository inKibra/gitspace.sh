export type WorkspaceStatusColor = 'dim' | 'green' | 'blue' | 'orange' | 'red';
export type WorkspaceAgentState = 'permission-needed' | 'running' | 'waiting' | 'retrying' | 'closed' | 'dormant' | 'archived';

export interface WorkspaceStatusSummary {
  primaryColor: WorkspaceStatusColor;
  agents: { green: number; blue: number; orange: number; red: number };
  services: { green: number; red: number };
  terminals: { green: number; red: number };
}

const ACTIONABLE_AGENT_ERROR_PATTERNS = [
  /credit|credits|quota|billing/i,
  /rate\s*limit|429/i,
  /api\s*key|unauthori[sz]ed|forbidden|authentication/i,
  /provider|model|openai|anthropic|gemini/i,
  /network|connection|timeout/i,
];
const NOISY_AGENT_ERROR_PATTERNS = [/\blsp\b/i, /language\s+server/i];

function actionableError(message: string | undefined): boolean {
  if (!message || NOISY_AGENT_ERROR_PATTERNS.some((pattern) => pattern.test(message))) return false;
  return ACTIONABLE_AGENT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function deriveWorkspaceStatusSummary(input: {
  agents: Array<{ state: WorkspaceAgentState; errorMessage?: string }>;
  services?: Array<{ running: boolean; exitCode?: number }>;
  terminals?: Array<{ running: boolean; exitCode?: number }>;
  serviceConfigError?: boolean;
}): WorkspaceStatusSummary {
  const agents = { green: 0, blue: 0, orange: 0, red: 0 };
  const services = { green: 0, red: 0 };
  const terminals = { green: 0, red: 0 };
  for (const agent of input.agents) {
    switch (agent.state) {
      case 'archived':
      case 'closed':
      case 'dormant':
        break;
      case 'permission-needed':
        agents.orange += 1;
        break;
      case 'running':
        agents.green += 1;
        break;
      case 'waiting':
        agents.blue += 1;
        break;
      case 'retrying':
        if (agent.errorMessage && !actionableError(agent.errorMessage)) agents.blue += 1;
        else agents.red += 1;
        break;
    }
  }
  for (const service of input.services ?? []) {
    if (service.running) services.green += 1;
    else if (service.exitCode !== undefined && service.exitCode !== 0) services.red += 1;
  }
  if (input.serviceConfigError) services.red += 1;
  for (const terminal of input.terminals ?? []) {
    if (terminal.running) terminals.green += 1;
    else if (terminal.exitCode !== undefined && terminal.exitCode !== 0) terminals.red += 1;
  }
  let primaryColor: WorkspaceStatusColor = 'dim';
  if (agents.orange > 0) primaryColor = 'orange';
  else if (agents.green > 0) primaryColor = 'green';
  else if (agents.blue > 0) primaryColor = 'blue';
  else if (agents.red > 0 || services.red > 0 || terminals.red > 0) primaryColor = 'red';
  return { primaryColor, agents, services, terminals };
}

export interface ActiveWorkspaceStatusItem {
  id: string;
  projectId: string;
  projectName: string;
  name: string;
  status: WorkspaceStatusSummary;
}

function tier(item: ActiveWorkspaceStatusItem, currentWorkspaceId: string): number {
  if (item.id === currentWorkspaceId) return -1;
  const color = item.status.primaryColor;
  if (color === 'orange' || color === 'red') return 0;
  if (color === 'blue') return 1;
  if (color === 'green') return 2;
  return 3;
}

export function visibleActiveWorkspaces<T extends ActiveWorkspaceStatusItem>(workspaces: readonly T[], currentWorkspaceId: string): T[] {
  return [...workspaces]
    .filter((workspace) => workspace.id === currentWorkspaceId || workspace.status.primaryColor !== 'dim')
    .sort((left, right) => {
      const tierDifference = tier(left, currentWorkspaceId) - tier(right, currentWorkspaceId);
      if (tierDifference !== 0) return tierDifference;
      const projectDifference = left.projectName.localeCompare(right.projectName);
      return projectDifference !== 0 ? projectDifference : left.name.localeCompare(right.name);
    });
}
