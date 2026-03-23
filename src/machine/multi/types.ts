import type { BackendKey } from '../../session/backend.js';
import type { MachineSnapshot } from '../../lib/tmux-lite/machine/protocol.js';

export interface BackendMachineState {
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  snapshot: MachineSnapshot | null;
  lastError?: string | null;
  /** Human-readable label for this backend's machine (from BackendDescriptor.label) */
  label: string;
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
