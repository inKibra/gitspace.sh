import type { ProcessPortProtocol } from '../../types/processes.js';

export interface PortConflictInfo {
  port: number;
  protocol: ProcessPortProtocol;
  pid: number;
  command?: string;
  user?: string;
  address?: string;
  managedSessionId?: string;
  managedSessionName?: string;
  managedWorkspaceId?: string;
  managedProcessName?: string;
  managedInstance?: number;
}

export class PortConflictError extends Error {
  readonly code = 'PORT_CONFLICT';
  readonly conflicts: PortConflictInfo[];

  constructor(processName: string, conflicts: PortConflictInfo[]) {
    super(buildConflictMessage(processName, conflicts));
    this.name = 'PortConflictError';
    this.conflicts = conflicts;
  }
}

function buildConflictMessage(processName: string, conflicts: PortConflictInfo[]): string {
  const summary = conflicts
    .map((conflict) => {
      const owner = conflict.managedSessionId
        ? `${conflict.managedProcessName ?? 'service'}#${conflict.managedInstance ?? 1} (${conflict.managedWorkspaceId ?? 'managed'})`
        : `${conflict.command ?? 'unknown process'} (pid ${conflict.pid})`;
      return `:${conflict.port} -> ${owner}`;
    })
    .join(', ');
  return `Cannot start ${processName}; port already in use: ${summary}`;
}

export function normalizeProcessPortProtocol(protocol?: ProcessPortProtocol): ProcessPortProtocol {
  return protocol === 'tcp' ? 'tcp' : 'http';
}
