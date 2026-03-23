/**
 * Workspace state utilities.
 */

export {
  type WorkspaceStatusInput,
  type WorkspaceStatusColor,
  type WorkspaceStatusCounts,
  type WorkspaceStatusSummary,
  deriveWorkspaceStatusSummary,
  buildWorkspaceStatusSummaryMap,
} from './workspace-status.js';

export {
  COMMAND_PALETTE_COMMAND_DEFS,
  type CommandPaletteCommandId,
} from './commandPaletteCommands.js';

export {
  useCommandPaletteState,
  type CommandPaletteCommand,
  type UseCommandPaletteStateOptions,
  type CommandPaletteStateResult,
} from './useCommandPaletteState.js';
