import type { AgentSessionInfo, ReplayInfo, SessionInfo, WorkspaceInfo } from '../../../components/SpacesBrowser.js';
import type {
  WorkspaceDetailStripStatus,
  WorkspaceDetailStripWorkspace,
} from '../../../components/WorkspaceDetailPane.js';
import type { WorkspaceRuntimeEntry } from '../workspace-runtime/types.js';
import type { WorkspaceNote, WorkspaceNotesSummary } from '../../../types/workspace.js';
import type { TodoPhase } from '../../../agents/agent-runtime-types.js';

export interface WorkspaceDetailModelInput {
  workspace: WorkspaceInfo;
  sessions: SessionInfo[];
  replays: ReplayInfo[];
  agentSessions?: AgentSessionInfo[];
  allWorkspaces?: WorkspaceDetailStripWorkspace[];
  workspaceStatusById?: Record<string, WorkspaceDetailStripStatus>;
  runtime?: WorkspaceRuntimeEntry | null;
  actions?: {
    onSelectWorkspace?: (workspaceId: string) => void;
    onAttachSession?: (params: { sessionId?: string; workspaceId?: string; viewOnly?: boolean }) => void | Promise<void>;
    onOpenReplay?: (replayId: string) => void | Promise<void>;
    onOpenReplayHistory?: (args: { workspaceId: string; workspaceName: string; replayRows: WorkspaceDetailReplayRow[] }) => void | Promise<void>;
    onStartProcessAttach?: (params: { workspaceId: string; processName: string; instance: number }) => void;
    onStopProcess?: (params: { workspaceId: string; processName: string }) => void;
    onManageBundleConfig?: (params: { workspaceId: string }) => void;
    onEditProcesses?: (params: { workspaceId: string }) => void;
    onOpenReview?: (workspaceId: string) => void | Promise<void>;
    onOpenGitHubPullRequest?: (workspaceId: string) => void | Promise<void>;
    onLaunchCommit?: (workspaceId: string) => void | Promise<void>;
    onRequestStatusChange?: (workspaceId: string, projectName: string) => void | Promise<void>;
    onOpenAgentSession?: (workspaceId: string, agentSessionId: string) => void | Promise<void>;
    onCreateAgentSession?: (workspaceId: string) => void | Promise<void>;
    onAbortAgentSession?: (workspaceId: string, agentSessionId: string) => void | Promise<void>;
    onCloseAgentSession?: (workspaceId: string, agentSessionId: string) => void | Promise<void>;
    onArchiveAgentSession?: (workspaceId: string, agentSessionId: string) => void | Promise<void>;
    onRestoreAgentSession?: (workspaceId: string, agentSessionId: string) => void | Promise<void>;
    onDeleteSession?: (sessionId: string, sessionName: string) => void;
  };
}

export interface WorkspaceDetailReplayRow {
  replayId: string;
  label: string;
  tone: 'green' | 'red';
  processLabel?: string;
  statusLabel: 'crashed' | 'completed' | 'running';
  timeLabel?: string;
  detailLabel?: string;
}

export interface WorkspaceDetailNoteRow {
  id: string;
  kind: 'todo' | 'note';
  label: string;
  priority?: WorkspaceNote['priority'];
  done: boolean;
}

export interface WorkspaceDetailModel {
  phase: string;
  phaseLabel: string;
  workspaceSessions: SessionInfo[];
  workspaceReplays: ReplayInfo[];
  visibleStripWorkspaces: WorkspaceDetailStripWorkspace[];
  stripDisplayItems: Array<
    | { type: 'workspace'; workspace: WorkspaceDetailStripWorkspace }
    | { type: 'project-label'; projectName: string; tier: number }
  >;
  currentWorkspaceStripIndex: number;
  activeAgentSessions: AgentSessionInfo[];
  archivedAgentSessions: AgentSessionInfo[];
  showArchivedAgents: boolean;
  toggleArchivedAgents: () => void;
  agentRows: Array<{
    id: string;
    title: string;
    bucket: 'active' | 'closed' | 'archived';
    state: 'needs-permission' | 'running' | 'waiting' | 'retrying' | 'error' | 'closed' | 'archived';
    lastActiveLabel?: string;
    modelLabel?: string;
  }>;
  /** Todo phases from the active agent session (if running in-process). */
  agentTodoPhases?: TodoPhase[];
  sessionRows: Array<{
    id: string;
    label: string;
    attached: boolean;
    statusLabel: 'attached' | 'idle';
    subtitle?: string;
    alertLabel?: string;
  }>;
  replayRows: WorkspaceDetailReplayRow[];
  visibleReplayRows: WorkspaceDetailReplayRow[];
  hiddenReplayCount: number;
  hasMoreReplayRows: boolean;
  seeAllReplayLabel?: string;
  notesSummary?: WorkspaceNotesSummary;
  visibleTodoRows: WorkspaceDetailNoteRow[];
  visibleRecentNoteRows: WorkspaceDetailNoteRow[];
  serviceRows: Array<{
    key: string;
    processName: string;
    instance: number;
    label: string;
    portLabel?: string;
    localUrl?: string;
    hostedUrl?: string;
    state: 'running' | 'stopped' | 'failed' | 'disabled';
    subtitle?: string;
    alertLabel?: string;
    attachableSessionId?: string;
  }>;
  pmRows: Array<{
    id: string;
    section: 'pull-request' | 'linear';
    label: string;
    detail?: string;
    tone: 'green' | 'blue' | 'red' | 'dim';
    actionable?: boolean;
  }>;
  footerActions: Array<{
    id: 'open-github-pr' | 'open-review' | 'launch-commit' | 'edit-bundle-config' | 'edit-process-config' | 'change-status';
    label: string;
    rightLabel?: string;
  }>;
  actions: {
    selectWorkspace: (workspaceId: string) => void;
    attachSession: (sessionId: string) => void | Promise<void>;
    createSession: () => void | Promise<void>;
    deleteSession: (sessionId: string, sessionName: string) => void;
    openReplay: (replayId: string) => void | Promise<void>;
    openReplayHistory: () => void | Promise<void>;
    activateService: (processName: string, instance: number, state: 'running' | 'stopped' | 'failed' | 'disabled') => void | Promise<void>;
    footerAction: (id: 'open-github-pr' | 'open-review' | 'launch-commit' | 'edit-bundle-config' | 'edit-process-config' | 'change-status') => void | Promise<void>;
    openAgentSession: (agentSessionId: string) => void | Promise<void>;
    createAgentSession: () => void | Promise<void>;
    abortAgentSession: (agentSessionId: string) => void | Promise<void>;
    closeAgentSession: (agentSessionId: string) => void | Promise<void>;
    archiveAgentSession: (agentSessionId: string) => void | Promise<void>;
    restoreAgentSession: (agentSessionId: string) => void | Promise<void>;
  };
}
