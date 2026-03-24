import type { MachineEvent, MachineSnapshot } from './types.js';

export type { MachineEvent, MachineSnapshot } from './types.js';

export interface MachineProjectFilter {
  projectIds?: string[];
}

export interface MachineWorkspaceFilter {
  projectIds?: string[];
  workspaceIds?: string[];
}

export interface MachineTerminalSessionFilter {
  projectIds?: string[];
  workspaceIds?: string[];
  sessionIds?: string[];
  hidden?: boolean;
}

export interface MachineAgentSessionFilter {
  projectIds?: string[];
  workspaceIds?: string[];
  sessionIds?: string[];
  includeArchived?: boolean;
  includeClosed?: boolean;
}

export type MachineRequest =
  | { type: 'getMachineSnapshot' }
  | { type: 'watchMachineEvents' }
  | { type: 'listProjects'; filter?: MachineProjectFilter }
  | { type: 'listWorkspaces'; filter?: MachineWorkspaceFilter }
  | { type: 'listTerminalSessions'; filter?: MachineTerminalSessionFilter }
  | { type: 'listAgentSessions'; filter?: MachineAgentSessionFilter };

export type MachineResponse =
  | { type: 'machineSnapshot'; snapshot: MachineSnapshot }
  | { type: 'machineWatchStarted' }
  | { type: 'machineEvent'; event: MachineEvent };
