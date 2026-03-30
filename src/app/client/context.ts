import type { BackendScopedAgentSessionRef, BackendScopedWorkspaceRef } from '../../machine/multi/types.js';
import type { BackendKey, SessionBackend } from '../../session/backend.js';
import type { AppClientAgentSessionSummary } from './types.js';
import type { DeleteWorkspaceParams } from '../../session/backend.js';
import type { WorkspacePhase } from '../../types/config.js';

export interface AppClientMulti {
  getBackend: (backendKey: BackendKey) => SessionBackend | null;
  createAgentSession: (ref: BackendScopedWorkspaceRef, title?: string) => Promise<AppClientAgentSessionSummary[]>;
  abortAgentSession: (ref: BackendScopedAgentSessionRef) => Promise<boolean>;
  closeAgentSession: (ref: BackendScopedAgentSessionRef) => Promise<AppClientAgentSessionSummary[]>;
  archiveAgentSession: (ref: BackendScopedAgentSessionRef) => Promise<AppClientAgentSessionSummary[]>;
  restoreAgentSession: (ref: BackendScopedAgentSessionRef) => Promise<AppClientAgentSessionSummary[]>;
  attachAgentSession: (ref: BackendScopedAgentSessionRef, options?: { viewOnly?: boolean }) => Promise<void>;
  getAgentSessionPreference: (ref: BackendScopedWorkspaceRef) => Promise<string | null>;
  setAgentSessionPreference: (ref: BackendScopedWorkspaceRef, sessionId: string) => Promise<void>;
  respondToAgentPermission?: (ref: BackendScopedAgentSessionRef, permissionId: string, response: 'allow' | 'deny') => Promise<boolean>;
  requestInbox?: () => Promise<void> | void;
  clearInbox?: (id?: string) => Promise<void> | void;
  markInboxRead?: (id: string) => Promise<void> | void;
  setWorkspaceStatus?: (ref: BackendScopedWorkspaceRef, phase: WorkspacePhase) => Promise<void>;
  deleteWorkspace?: (ref: BackendScopedWorkspaceRef, params?: DeleteWorkspaceParams) => Promise<void>;
  listWorkspaces?: () => Promise<void> | void;
  listSessions?: () => Promise<void> | void;
  listReplays?: (workspaceId?: string, includeDismissed?: boolean) => Promise<void> | void;
}

export interface AppClientContext {
  multi: AppClientMulti;
  workspaceRefs: readonly BackendScopedWorkspaceRef[];
  agentSessionsByWorkspaceKey?: Readonly<Record<string, readonly AppClientAgentSessionSummary[] | undefined>>;
  selectedWorkspaceRef?: BackendScopedWorkspaceRef | null;
  detailWorkspaceRef?: BackendScopedWorkspaceRef | null;
  preferredBackendKey?: BackendKey | null;
}
