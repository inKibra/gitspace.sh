import type { SessionEngineState } from '../../session/types.js';
import type { BackendKey } from '../../session/backend.js';
import { selectWorkspaceAgents, selectWorkspaces, selectWorkspaceTerminals } from '../state/client.js';
import type { MachineAgentSessionRecord, MachineSnapshot, MachineWorkspaceRecord, MachineTerminalSessionRecord } from '../../lib/tmux-lite/machine/types.js';
import type { BackendMachineState, BackendScopedWorkspaceRef, MultiMachineState } from './types.js';

export function toMultiMachineState(state: SessionEngineState | null): MultiMachineState {
  if (!state) {
    return { byBackend: {}, backendOrder: [], activeBackendKey: null };
  }
  const byBackend: Record<BackendKey, BackendMachineState> = {};
  for (const key of state.backendOrder) {
    const backend = state.backends[key];
    if (!backend) continue;
    byBackend[key] = {
      status: backend.status,
      snapshot: backend.machineSnapshot,
      lastError: backend.error,
      label: backend.descriptor.label,
    };
  }
  return {
    byBackend,
    backendOrder: state.backendOrder,
    activeBackendKey: state.activeBackendKey,
  };
}

export function selectBackendSnapshot(state: MultiMachineState, backendKey: BackendKey): MachineSnapshot | null {
  return state.byBackend[backendKey]?.snapshot ?? null;
}

export function selectAllWorkspaces(state: MultiMachineState): Array<{ backendKey: BackendKey; workspace: MachineWorkspaceRecord }> {
  const result: Array<{ backendKey: BackendKey; workspace: MachineWorkspaceRecord }> = [];
  for (const backendKey of state.backendOrder) {
    const snapshot = state.byBackend[backendKey]?.snapshot;
    if (!snapshot) continue;
    for (const workspace of selectWorkspaces(snapshot)) {
      result.push({ backendKey, workspace });
    }
  }
  return result;
}

export function selectWorkspaceForRef(state: MultiMachineState, ref: BackendScopedWorkspaceRef | null): MachineWorkspaceRecord | null {
  if (!ref) return null;
  const snapshot = selectBackendSnapshot(state, ref.backendKey);
  if (!snapshot) return null;
  return snapshot.workspacesById[ref.workspaceId] ?? null;
}

export function selectWorkspaceAgentsForRef(state: MultiMachineState, ref: BackendScopedWorkspaceRef | null): MachineAgentSessionRecord[] {
  if (!ref) return [];
  const snapshot = selectBackendSnapshot(state, ref.backendKey);
  if (!snapshot) return [];
  return selectWorkspaceAgents(snapshot, ref.workspaceId);
}

export function selectWorkspaceTerminalsForRef(state: MultiMachineState, ref: BackendScopedWorkspaceRef | null): MachineTerminalSessionRecord[] {
  if (!ref) return [];
  const snapshot = selectBackendSnapshot(state, ref.backendKey);
  if (!snapshot) return [];
  return selectWorkspaceTerminals(snapshot, ref.workspaceId);
}
