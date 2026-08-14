import type { AgentSessionInfo, SessionInfo, WorkspaceInfo } from '../../../components/SpacesBrowser.js';
import type { WorkspaceStatusSummary } from '../../workspaces/workspace-status.js';
import type { WorkspacePhase } from '../../../types/config.js';

export interface WorkspaceRuntimeSessionRow {
  id: string;
  label: string;
  attached: boolean;
  statusLabel: 'attached' | 'idle';
  subtitle?: string;
  alertLabel?: string;
}

export interface WorkspaceRuntimeProcessRow {
  key: string;
  processName: string;
  instance: number;
  label: string;
  portLabel?: string;
  state: 'running' | 'stopped' | 'failed' | 'disabled';
  subtitle?: string;
  alertLabel?: string;
  attachableSessionId?: string;
}

export interface WorkspaceRuntimeWorkspaceInfo extends WorkspaceInfo {
  backendKey: string;
  machineLabel: string;
  /** The kanban phase, as the machine snapshot reports it. Typed as the real
   *  union, not `string`: consumers were casting it back, which is how a chip
   *  ended up asserting a shape nothing had verified. */
  phase?: WorkspacePhase;
  selectionKey: string;
}

export interface WorkspaceRuntimeEntry {
  workspace: WorkspaceRuntimeWorkspaceInfo;
  sessions: SessionInfo[];
  shellSessions: SessionInfo[];
  processSessions: SessionInfo[];
  sessionRows: WorkspaceRuntimeSessionRow[];
  processRows: WorkspaceRuntimeProcessRow[];
  agentSessions: AgentSessionInfo[];
  agentSessionCount: number;
  pendingPermissionCount: number;
  statusSummary: WorkspaceStatusSummary;
  stripStatus: { primaryColor: WorkspaceStatusSummary['primaryColor'] };
}

export interface WorkspaceRuntimeModel {
  workspaces: WorkspaceRuntimeWorkspaceInfo[];
  sessions: SessionInfo[];
  agentSessionsByWorkspace: Record<string, AgentSessionInfo[]>;
  agentSessionCounts: Record<string, number>;
  pendingPermissionsByWorkspace: Record<string, number>;
  workspaceStatusById: Record<string, WorkspaceStatusSummary>;
  stripStatusById: Record<string, { primaryColor: WorkspaceStatusSummary['primaryColor'] }>;
  runtimeByWorkspace: Record<string, WorkspaceRuntimeEntry>;
}
