import type { BackendKey } from '../../session/backend.js';
import type { MachineSnapshot } from '../../lib/tmux-lite/machine/protocol.js';
import type { WorkspaceInfo } from '../../lib/remote-session/protocol.js';

export interface BackendMachineState {
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  snapshot: MachineSnapshot | null;
  lastError?: string | null;
  label: string;
  workspaces?: WorkspaceInfo[];
  /** Non-null when an agent session terminal is attached. */
  attachedAgentSessionId?: string | null;
  attachedWorkspaceId?: string | null;
  pendingDialogRequest?: import('../../lib/tmux-lite/agents/host-ui-bridge.js').HostUIDialogRequest | null;
  agentWorkingMessage?: string;
  pendingDialogByAgentSessionId?: Record<string, import('../../lib/tmux-lite/agents/host-ui-bridge.js').HostUIDialogRequest>;
  workingMessageByAgentSessionId?: Record<string, string>;
  pendingAgentAttach?: boolean;
}
export interface MultiMachineState {
  byBackend: Record<BackendKey, BackendMachineState>;
  backendOrder: BackendKey[];
  activeBackendKey: BackendKey | null;
}

export interface BackendScopedWorkspaceRef {
  backendKey: BackendKey;
  workspaceId: string;
}

export interface BackendScopedSessionRef {
  backendKey: BackendKey;
  sessionId: string;
}

export interface BackendScopedAgentSessionRef {
  backendKey: BackendKey;
  workspaceId: string;
  agentSessionId: string;
}

export function toBackendScopedWorkspaceKey(ref: BackendScopedWorkspaceRef): string {
  return JSON.stringify([ref.backendKey, ref.workspaceId]);
}
