/**
 * TUI Adapters
 *
 * Convert between TUI state types and shared component types.
 * Allows TUI to use shared hooks while maintaining its data format.
 */

import type { WorkspaceState, WorkspaceSession } from './state.js';
import type {
  WorkspaceInfo,
  SessionInfo,
  MachineInfo,
} from '../shared/components/index.js';

// ============================================================================
// Workspace Adapters
// ============================================================================

/**
 * Convert TUI WorkspaceState array to shared WorkspaceInfo array
 */
export function toWorkspaceInfoList(
  workspaces: WorkspaceState[],
  projectName: string
): WorkspaceInfo[] {
  return workspaces.map((ws) => ({
    id: ws.name, // Use name as ID for local workspaces
    name: ws.name,
    path: ws.path,
    projectName,
    branch: ws.branch,
    sessionCount: ws.sessions.length,
    isStale: ws.isStale,
  }));
}

/**
 * Extract SessionInfo array from TUI WorkspaceState array
 */
export function extractSessionInfoList(
  workspaces: WorkspaceState[]
): SessionInfo[] {
  const sessions: SessionInfo[] = [];

  for (const ws of workspaces) {
    for (const session of ws.sessions) {
      sessions.push({
        id: session.id,
        name: session.name,
        workspaceId: ws.name, // Match the id used in toWorkspaceInfoList
        attached: session.attached,
        createdAt: session.createdAt,
        processTitle: session.processTitle,
        processName: session.processName,
        processInstance: session.processInstance,
      });
    }
  }

  return sessions;
}

/**
 * Find workspace by ID (name) in TUI state
 */
export function findWorkspaceById(
  workspaces: WorkspaceState[],
  workspaceId: string
): WorkspaceState | undefined {
  return workspaces.find((ws) => ws.name === workspaceId);
}

/**
 * Find session by ID across all workspaces
 */
export function findSessionById(
  workspaces: WorkspaceState[],
  sessionId: string
): { workspace: WorkspaceState; session: WorkspaceSession } | undefined {
  for (const ws of workspaces) {
    const session = ws.sessions.find((s) => s.id === sessionId);
    if (session) {
      return { workspace: ws, session };
    }
  }
  return undefined;
}

// ============================================================================
// Machine Adapters
// ============================================================================

/**
 * Create a local machine info entry for the machine list
 */
export function createLocalMachineInfo(): MachineInfo {
  return {
    machineId: 'local',
    label: 'This Machine',
    online: true,
    isAuthorized: true,
  };
}

/**
 * Convert relay machine data to shared MachineInfo format
 */
export function toMachineInfo(data: {
  machineId: string;
  label?: string;
  online: boolean;
  isAuthorized: boolean;
  lastConnectedAt?: number;
}): MachineInfo {
  return {
    machineId: data.machineId,
    label: data.label,
    online: data.online,
    isAuthorized: data.isAuthorized,
    lastConnectedAt: data.lastConnectedAt,
  };
}
