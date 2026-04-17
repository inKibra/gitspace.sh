/**
 * WorkspaceDetailPane - Shared types for the dedicated workspace detail view.
 * Used when a single workspace is selected from the board (replaces filtered browser).
 */

import type { WorkspaceInfo, SessionInfo, ReplayInfo } from './SpacesBrowser.js';
import type { AgentSessionInfo } from './SpacesBrowser.js';
import type { WorkspaceStatusInput, WorkspaceStatusSummary } from '../app/workspaces/workspace-status.js';
import type { WorkspaceDetailReplayRow } from '../app/shared/workspace-detail/types.js';
import type { WorkspaceRuntimeEntry } from '../app/shared/workspace-runtime/types.js';

export type WorkspaceDetailStripWorkspace = WorkspaceStatusInput & {
  name: string;
  projectName: string;
  selectionKey?: string;
};

export type WorkspaceDetailStripStatus = Pick<WorkspaceStatusSummary, 'primaryColor'>;

export interface WorkspaceDetailPaneProps {
  workspace: WorkspaceInfo;
  sessions: SessionInfo[];
  replays: ReplayInfo[];
  agentSessions?: AgentSessionInfo[];
  agentSessionCount?: number;
  pendingPermissions?: number;
  onAttachSession: (params: { sessionId?: string; workspaceId?: string; viewOnly?: boolean }) => void | Promise<void>;
  onOpenReplay: (replayId: string) => void | Promise<void>;
  onOpenReplayHistory?: (args: { workspaceId: string; workspaceName: string; replayRows: WorkspaceDetailReplayRow[] }) => void | Promise<void>;
  onStartProcess: (params: { workspaceId: string; processName: string; instance?: number }) => void;
  onStartProcessAttach: (params: { workspaceId: string; processName: string; instance: number }) => void;
  onStopProcess: (params: { workspaceId: string; processName: string }) => void;
  onEditProcesses: (params: { workspaceId: string }) => void;
  onManageBundleConfig: (params: { workspaceId: string }) => void;
  onOpenReview?: (workspaceId: string) => void | Promise<void>;
  onOpenGitHubPullRequest?: (workspaceId: string) => void | Promise<void>;
  onLaunchCommit?: (workspaceId: string) => void | Promise<void>;
  onRequestStatusChange?: (workspaceId: string, projectName: string) => void | Promise<void>;
  onOpenEvents: (workspaceId: string) => void;
  onOpenAgentSession?: (workspaceId: string, agentSessionId: string) => void | Promise<void>;
  onCreateAgentSession?: (workspaceId: string) => void | Promise<void>;
  onKillAgentSession?: (workspaceId: string, agentSessionId: string) => void | Promise<void>;
  onStopAgentTurn?: (workspaceId: string, agentSessionId: string) => void | Promise<void>;
  onCloseAgentSession?: (workspaceId: string, agentSessionId: string) => void | Promise<void>;
  onArchiveAgentSession?: (workspaceId: string, agentSessionId: string) => void | Promise<void>;
  onRestoreAgentSession?: (workspaceId: string, agentSessionId: string) => void | Promise<void>;
  onDeleteSession?: (sessionId: string, sessionName: string) => void;
  /** Raw cross-project workspaces available for the header strip. */
  allWorkspaces?: WorkspaceDetailStripWorkspace[];
  /** Platform-neutral status map used to filter/sort the header strip. */
  workspaceStatusById?: Record<string, WorkspaceDetailStripStatus>;
  runtime?: WorkspaceRuntimeEntry | null;
  attachedSessionId?: string | null;
  attachedAgentSessionId?: string | null;
  pendingAgentAttach?: boolean;
  /** Called when user clicks a workspace in the header strip to switch to it. */
  onSelectWorkspace?: (workspaceSelectionKey: string) => void | Promise<void>;
  onClose: () => void;
}
