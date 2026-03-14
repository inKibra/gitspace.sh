import type { NotificationConfig } from '../notifications/types.js';
import type { BackendEvent } from './events.js';
import type {
  BundleRefreshPlan,
  BundleRefreshSubmission,
} from '../types/bundle-refresh.js';
import type {
  BundleConfigState,
  BundleConfigSubmission,
} from '../types/bundle-config.js';
import type { ReviewOperation, ReviewResult } from '../types/review.js';
import type { WideEventFilter } from '../types/events.js';
import type { SessionLinearIssueSummary, WorkspaceSource } from '../types/lifecycle.js';
import type { ConfirmStepResult, SpacesBundle } from '../types/bundle.js';

export type BackendKey = string;
export type BackendKind = 'local' | 'remote';

export interface BackendDescriptor {
  key: BackendKey;
  kind: BackendKind;
  label: string;
  machineId?: string;
  relayUrl?: string;
}

export interface AttachSessionParams {
  sessionId?: string;
  workspaceId?: string;
  sessionName?: string;
  cols?: number;
  rows?: number;
  scriptPolicy?: 'auto' | 'skip';
  /** When true, the client cannot send input to the PTY (view-only mode) */
  viewOnly?: boolean;
  /** Custom command to run (skips workspace scripts when set) */
  command?: string;
  /** Arguments for the custom command */
  args?: string[];
  /** Environment variables for the custom command */
  env?: Record<string, string>;
}

export interface DeleteWorkspaceParams {
  scriptPolicy?: 'auto' | 'skip';
  /**
   * Optional timeout for delete completion when waiting on remote responses.
   * Ignored by local backend.
   */
  timeoutMs?: number;
}

export interface CreateProjectParams {
  repository: string;
  projectName?: string;
  baseBranch?: string;
  setCurrent?: boolean;
}

export interface PreparedProjectResult {
  projectName: string;
  repository: string;
  baseBranch: string;
  bundle?: SpacesBundle;
  confirmStatuses?: Record<string, 'found' | 'missing'>;
}

export interface FinalizeProjectParams {
  projectName: string;
  repository: string;
  baseBranch: string;
  bundle?: SpacesBundle;
  inputValues?: Record<string, string>;
  secretValues?: Record<string, string>;
  confirmResults?: Record<string, ConfirmStepResult>;
  setCurrent?: boolean;
}

export interface CreateWorkspaceParams {
  projectName: string;
  workspaceName: string;
  branchName?: string;
  baseBranch?: string;
  workspaceSource?: WorkspaceSource;
  linearIssue?: SessionLinearIssueSummary;
}

export interface DeleteProjectParams {
  /**
   * Optional timeout for delete completion when waiting on remote responses.
   * Ignored by local backend.
   */
  timeoutMs?: number;
}

/**
 * Canonical backend contract used by shared session engine.
 */
export interface SessionBackend {
  readonly descriptor: BackendDescriptor;

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  listProjects(): Promise<void>;
  listGithubRepos(org?: string): Promise<string[]>;
  listRemoteBranches(projectName: string): Promise<string[]>;
  listLinearIssues(projectName: string): Promise<SessionLinearIssueSummary[]>;
  listWorkspaces(): Promise<void>;
  listSessions(workspaceId?: string): Promise<void>;

  createProject(params: CreateProjectParams): Promise<void>;
  prepareProjectCreation?(params: CreateProjectParams): Promise<PreparedProjectResult>;
  finalizeProjectCreation?(params: FinalizeProjectParams): Promise<void>;
  cancelProjectCreation?(projectName: string): Promise<void>;
  createWorkspace(params: CreateWorkspaceParams): Promise<void>;
  deleteProject(projectName: string, params?: DeleteProjectParams): Promise<void>;

  attachSession(params: AttachSessionParams): Promise<void>;
  detachSession(): Promise<void>;
  cancelPendingScripts?(): Promise<void>;

  killSession(sessionId: string): Promise<void>;
  deleteWorkspace(
    projectName: string,
    workspaceId: string,
    params?: DeleteWorkspaceParams
  ): Promise<void>;

  getBundleRefreshPlan(projectName: string, workspaceId: string): Promise<BundleRefreshPlan>;
  applyBundleRefresh(
    projectName: string,
    workspaceId: string,
    submission: BundleRefreshSubmission
  ): Promise<void>;
  getBundleConfigState(projectName: string, workspaceId: string): Promise<BundleConfigState>;
  applyBundleConfigUpdate(
    projectName: string,
    workspaceId: string,
    submission: BundleConfigSubmission
  ): Promise<void>;

  requestInbox(): Promise<void>;
  clearInbox(id?: string): Promise<void>;
  markInboxRead(id: string): Promise<void>;

  getNotificationConfig(): Promise<void>;
  updateNotificationConfig(config: NotificationConfig): Promise<void>;

  sendReviewRequest(operation: ReviewOperation): Promise<ReviewResult>;
  startProcess?(workspaceId: string, processName: string, instance?: number): Promise<void>;
  stopProcess?(workspaceId: string, processName: string): Promise<void>;
  requestEvents?(workspacePath: string, filter?: WideEventFilter, limit?: number, sinceMs?: number): Promise<void>;

  writePtyData?(data: Uint8Array): Promise<void>;
  resizePty?(cols: number, rows: number): Promise<void>;

  onEvent(handler: (event: BackendEvent) => void): () => void;
}
