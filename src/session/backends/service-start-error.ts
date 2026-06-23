import { PortConflictError } from '../../lib/processes/port-conflicts.js';
import type { Response as TmuxResponse } from '../../lib/tmux-lite/protocol.js';

type TmuxErrorResponse = Extract<TmuxResponse, { type: 'error' }>;

export function throwServiceStartError(response: TmuxErrorResponse): never {
  if (
    response.code === 'PORT_CONFLICT'
    && typeof response.processName === 'string'
    && response.processName.trim().length > 0
    && Array.isArray(response.portConflicts)
    && response.portConflicts.length > 0
  ) {
    throw new PortConflictError(response.processName, response.portConflicts);
  }

  throw new Error(response.message);
}
