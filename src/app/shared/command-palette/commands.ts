import type { CommandPaletteCommandId } from '../../workspaces/commandPaletteCommands.js';
import type { CommandPaletteWorkspaceLike } from './workspace-selection.js';

type SharedCommandResult<T extends CommandPaletteWorkspaceLike> =
  | { kind: 'unhandled' }
  | { kind: 'add-repo' }
  | { kind: 'add-workspace' }
  | { kind: 'delete-repo'; projectName: string }
  | { kind: 'missing-project' }
  | { kind: 'missing-workspace' }
  | { kind: 'set-status'; workspace: T }
  | { kind: 'delete-workspace'; workspace: T }
  | { kind: 'edit-bundle-config'; workspace: T }
  | { kind: 'refresh-bundle'; workspace: T }
  | { kind: 'edit-process-config'; workspace: T }
  | { kind: 'open-service'; workspace: T };

export function resolveSharedCommand<T extends CommandPaletteWorkspaceLike>(
  commandId: CommandPaletteCommandId,
  args: { workspace: T | null; projectName: string | null },
): SharedCommandResult<T> {
  const { workspace, projectName } = args;
  switch (commandId) {
    case 'add-repo':
      return { kind: 'add-repo' };
    case 'add-workspace':
      return { kind: 'add-workspace' };
    case 'delete-repo':
      return projectName ? { kind: 'delete-repo', projectName } : { kind: 'missing-project' };
    case 'set-status':
      return workspace ? { kind: 'set-status', workspace } : { kind: 'missing-workspace' };
    case 'delete-workspace':
      return workspace ? { kind: 'delete-workspace', workspace } : { kind: 'missing-workspace' };
    case 'edit-bundle-config':
      return workspace ? { kind: 'edit-bundle-config', workspace } : { kind: 'missing-workspace' };
    case 'refresh-bundle':
      return workspace ? { kind: 'refresh-bundle', workspace } : { kind: 'missing-workspace' };
    case 'edit-process-config':
      return workspace ? { kind: 'edit-process-config', workspace } : { kind: 'missing-workspace' };
    case 'open-service':
      return workspace ? { kind: 'open-service', workspace } : { kind: 'missing-workspace' };
    default:
      return { kind: 'unhandled' };
  }
}

export function getMissingSelectionTitle(commandId: CommandPaletteCommandId): string {
  switch (commandId) {
    case 'delete-workspace':
      return 'Delete Workspace';
    case 'edit-bundle-config':
      return 'Edit Bundle Config';
    case 'refresh-bundle':
      return 'Refresh Bundle';
    case 'edit-process-config':
      return 'Edit Process Config';
    case 'delete-repo':
      return 'Delete Repo';
    case 'open-github-pr':
      return 'Open GitHub PR';
    case 'open-review':
      return 'Open Review';
    case 'open-service':
      return 'Open Service';
    case 'set-status':
    default:
      return 'Set Status';
  }
}
