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
      workspaces: backend.workspaces,
      lastError: backend.error,
      label: backend.descriptor.label,
      attachedAgentSessionId: backend.attachedAgentSessionId,
      attachedWorkspaceId: backend.attachedWorkspaceId,
      pendingDialogRequest: backend.pendingDialogRequest,
      agentWorkingMessage: backend.agentWorkingMessage,
      pendingAgentAttach: backend.pendingAgentAttach,
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
    const seen = new Set<string>();
    if (snapshot) {
      for (const workspace of selectWorkspaces(snapshot)) {
        seen.add(workspace.id);
        result.push({ backendKey, workspace });
      }
    }

    for (const workspaceInfo of state.byBackend[backendKey]?.workspaces ?? []) {
      const workspaceId = workspaceInfo.id.includes(':') ? workspaceInfo.id : `${workspaceInfo.projectName}:${workspaceInfo.id}`;
      if (seen.has(workspaceId)) continue;
      const workspace: MachineWorkspaceRecord = {
        id: workspaceId,
        name: workspaceInfo.name,
        projectId: workspaceInfo.projectName,
        projectName: workspaceInfo.projectName,
        path: workspaceInfo.path,
        branch: workspaceInfo.branch,
        phase: workspaceInfo.status,
        isStale: workspaceInfo.isStale,
        serveDomain: workspaceInfo.serveDomain,
        processes: workspaceInfo.processes,
        processConfigError: workspaceInfo.processConfigError,
        notesSummary: workspaceInfo.notesSummary,
        terminalSessionIds: [],
        agentSessionIds: [],
        processIds: [],
        replayIds: [],
        summary: {
          terminalCount: workspaceInfo.sessionCount ?? 0,
          attachedTerminalCount: 0,
          runningTerminalCount: workspaceInfo.sessionCount ?? 0,
          failedTerminalCount: 0,
          agentCount: 0,
          runningAgentCount: 0,
          waitingAgentCount: 0,
          permissionAgentCount: 0,
          retryingAgentCount: 0,
          closedAgentCount: 0,
          archivedAgentCount: 0,
          configuredProcessCount: workspaceInfo.processes?.length ?? 0,
          runningProcessCount: 0,
          failedProcessCount: 0,
        },
      };
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
