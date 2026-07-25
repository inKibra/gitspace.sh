import type { WorkspacePhase } from '../../../types/config.js';
import type { WorkspaceNotesSummary } from '../../../types/workspace.js';

export type MachineAgentSessionState =
  | 'closed'
  | 'waiting'
  | 'running'
  | 'permission-needed'
  | 'retrying'
  | 'archived';

export type MachineTerminalSessionState =
  | 'running'
  | 'attached'
  | 'detached'
  | 'exited'
  | 'failed';

export interface MachineProjectRecord {
  id: string;
  name: string;
  repository: string;
  isCurrent: boolean;
  workspaceIds: string[];
  workspaceCount: number;
}

export type MachineWorkspacePmSyncState =
  | 'loading'
  | 'ready'
  | 'not_found'
  | 'unconfigured'
  | 'unavailable';

export type MachineWorkspacePullRequestSyncState =
  | 'loading'
  | 'ready'
  | 'not_found'
  | 'cli_missing'
  | 'unauthenticated'
  | 'unavailable';

export type MachineWorkspaceLinearSyncState =
  | 'loading'
  | 'ready'
  | 'identifier_missing'
  | 'not_found'
  | 'unconfigured'
  | 'unavailable';

export interface MachineWorkspacePmActor {
  login: string;
  url?: string;
}

export type MachinePullRequestReviewDecision =
  | 'approved'
  | 'changes_requested'
  | 'review_required';

export interface MachineWorkspacePullRequestRecord {
  syncState: MachineWorkspacePullRequestSyncState;
  checkedAt?: string;
  errorMessage?: string;
  number?: number;
  url?: string;
  title?: string;
  state?: 'open' | 'closed' | 'merged';
  isDraft?: boolean;
  author?: MachineWorkspacePmActor;
  reviewers: MachineWorkspacePmActor[];
  requestedReviewers: MachineWorkspacePmActor[];
  changesRequestedBy: MachineWorkspacePmActor[];
  reviewDecision?: MachinePullRequestReviewDecision;
}

export interface MachineWorkspaceLinearRecord {
  syncState: MachineWorkspaceLinearSyncState;
  checkedAt?: string;
  errorMessage?: string;
  identifier?: string;
  title?: string;
  url?: string;
  stateName?: string;
}

export interface MachineGoalRecord {
  id: string;
  chainId: string;
  chainTitle: string;
  title: string;
  projectName: string;
  phase: WorkspacePhase;
  plannedWorkspaceName?: string;
  workspaceName?: string;
  status: 'planned' | 'workspace-backed' | 'archived';
  chainPosition: number;
  chainLength: number;
  previousGoalId?: string;
  previousWorkspaceName?: string;
  blockedReason?: string;
  doc?: import('../../../types/goals.js').GoalDoc;
  validation?: import('../../../types/goals.js').GoalValidation;
  sourceRefs?: import('../../../types/goals.js').SourceRef[];
  updatedAt?: string;
  stackStatus?: import('../../../types/goals.js').ChainStackEdgeStatus['status'];
  stackStatusMessage?: string;
}


export interface MachineWorkspaceRecord {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
  path: string;
  branch?: string;
  phase?: WorkspacePhase;
  isStale?: boolean;
  serveDomain?: string;
  processes?: import('../../../types/processes.js').RuntimeProcessDefinition[];
  processConfigError?: string;
  notesSummary?: WorkspaceNotesSummary;
  pullRequest?: MachineWorkspacePullRequestRecord;
  linear?: MachineWorkspaceLinearRecord;
  goal?: MachineGoalRecord;
  terminalSessionIds: string[];
  agentSessionIds: string[];
  processIds: string[];
  replayIds: string[];
  summary: {
    terminalCount: number;
    attachedTerminalCount: number;
    runningTerminalCount: number;
    failedTerminalCount: number;
    agentCount: number;
    runningAgentCount: number;
    waitingAgentCount: number;
    permissionAgentCount: number;
    retryingAgentCount: number;
    closedAgentCount: number;
    archivedAgentCount: number;
    /** Archived sessions beyond the newest few carried inline in the snapshot
     *  (ticket #42). `archivedAgentCount + archivedMoreCount` is the true total;
     *  the extras are fetched on demand via the agent-sessions RPC. */
    archivedMoreCount?: number;
    configuredProcessCount: number;
    runningProcessCount: number;
    failedProcessCount: number;
  };
}

export interface MachineTerminalSessionRecord {
  id: string;
  name: string;
  workspaceId?: string;
  projectId?: string;
  cwd: string;
  /** Unix socket path for tmux-lite session attach. Populated from Session.socketPath in build.ts. */
  socketPath: string;
  kind: 'shell' | 'process' | 'agent';
  hidden: boolean;
  state: MachineTerminalSessionState;
  attached: boolean;
  createdAt: number;
  exitCode?: number;
  processTitle?: string;
  terminalTitle?: string;
  lastAlertKind?: import('../protocol.js').InboxItem['type'];
  lastAlertPreview?: string;
  lastAlertAt?: number;
  unreadAlertCount?: number;
  processName?: string;
  processInstance?: number;
  linkedAgentSessionId?: string;
  metadata?: Record<string, string>;
}

export interface MachineAgentSessionRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  title: string;
  state: MachineAgentSessionState;
  updatedAt?: string;
  closedAt?: string;
  archivedAt?: string;
  pendingPermissionIds: string[];
  pendingPermissionCount: number;
  pendingQuestionIds: string[];
  pendingQuestionCount: number;
  errorMessage?: string;
  lastMessagePreview?: string;
  linkedTerminalSessionId?: string;
  modelInfo?: import('../../../agents/agent-runtime-types.js').AgentModelInfo;
  todoPhases?: import('../../../agents/agent-runtime-types.js').TodoPhase[];
  queuedMessages?: { steering: string[]; followUp: string[] };
}

export interface MachineProcessRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  name: string;
  instance?: number;
  status: 'stopped' | 'starting' | 'running' | 'failed';
  terminalSessionId?: string;
  errorMessage?: string;
}

export interface MachineReplayRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  terminalSessionId?: string;
  sessionName?: string;
  status: 'running' | 'completed' | 'dismissed' | 'failed';
  dismissed: boolean;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
}

export interface MachineNotificationRecord {
  id: string;
  kind: 'session-exit' | 'bell' | 'osc' | 'agent' | 'permission' | 'system';
  workspaceId?: string;
  projectId?: string;
  terminalSessionId?: string;
  agentSessionId?: string;
  title: string;
  message?: string;
  read: boolean;
  createdAt: string;
}

export interface MachineSnapshot {
  snapshotNonce: number;
  generatedAt: string;
  projectsById: Record<string, MachineProjectRecord>;
  projectOrder: string[];
  workspacesById: Record<string, MachineWorkspaceRecord>;
  workspaceOrder: string[];
  workspaceIdsByProjectId: Record<string, string[]>;
  goalsById?: Record<string, MachineGoalRecord>;
  goalOrder?: string[];
  goalIdsByProjectId?: Record<string, string[]>;
  terminalSessionsById: Record<string, MachineTerminalSessionRecord>;
  terminalSessionIdsByWorkspaceId: Record<string, string[]>;
  agentSessionsById: Record<string, MachineAgentSessionRecord>;
  agentSessionIdsByWorkspaceId: Record<string, string[]>;
  processesById: Record<string, MachineProcessRecord>;
  processIdsByWorkspaceId: Record<string, string[]>;
  replaysById: Record<string, MachineReplayRecord>;
  replayIdsByWorkspaceId: Record<string, string[]>;
  notificationsById: Record<string, MachineNotificationRecord>;
  notificationOrder: string[];
}

export type MachineEvent =
  | { type: 'snapshot-replaced'; snapshotNonce: number; snapshot: MachineSnapshot }
  | { type: 'workspace-upserted'; snapshotNonce: number; workspace: MachineWorkspaceRecord }
  | { type: 'workspace-removed'; snapshotNonce: number; workspaceId: string }
  | { type: 'terminal-session-upserted'; snapshotNonce: number; session: MachineTerminalSessionRecord }
  | { type: 'terminal-session-removed'; snapshotNonce: number; sessionId: string; workspaceId?: string }
  | { type: 'agent-session-upserted'; snapshotNonce: number; session: MachineAgentSessionRecord }
  | { type: 'agent-session-removed'; snapshotNonce: number; sessionId: string; workspaceId: string }
  | { type: 'process-upserted'; snapshotNonce: number; process: MachineProcessRecord }
  | { type: 'process-removed'; snapshotNonce: number; processId: string; workspaceId: string }
  /** Scoped goal refresh: replaces ALL goals belonging to one project.
   *  goalOrder is project-scoped (ordering within the project). */
  | {
      type: 'project-goals-replaced';
      snapshotNonce: number;
      projectId: string;
      goalsById: Record<string, MachineGoalRecord>;
      goalOrder: string[];
    }
  /** Slim workspace refresh for session-derived fields (id lists + summary
   *  counts) — avoids re-shipping the whole record (embedded goal docs are
   *  heavy) on every terminal/agent lifecycle event. No-op if the workspace
   *  record is unknown (both sides apply the same transform, so it is
   *  unknown on both). */
  | {
      type: 'workspace-derived-replaced';
      snapshotNonce: number;
      workspaceId: string;
      terminalSessionIds: string[];
      agentSessionIds: string[];
      processIds: string[];
      summary: MachineWorkspaceRecord['summary'];
    };
