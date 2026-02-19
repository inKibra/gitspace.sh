import type { NotificationConfig } from '../notifications/types.js';
import type { BackendEvent } from './events.js';
import type {
  BundleRefreshPlan,
  BundleRefreshSubmission,
} from '../types/bundle-refresh.js';
import type { ReviewOperation, ReviewResult } from '../types/review.js';

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
}

export interface DeleteWorkspaceParams {
  scriptPolicy?: 'auto' | 'skip';
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
  listWorkspaces(): Promise<void>;
  listSessions(workspaceId?: string): Promise<void>;

  attachSession(params: AttachSessionParams): Promise<void>;
  detachSession(): Promise<void>;

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

  requestInbox(): Promise<void>;
  clearInbox(id?: string): Promise<void>;
  markInboxRead(id: string): Promise<void>;

  getNotificationConfig(): Promise<void>;
  updateNotificationConfig(config: NotificationConfig): Promise<void>;

  sendReviewRequest(operation: ReviewOperation): Promise<ReviewResult>;

  writePtyData?(data: Uint8Array): Promise<void>;
  resizePty?(cols: number, rows: number): Promise<void>;

  onEvent(handler: (event: BackendEvent) => void): () => void;
}
