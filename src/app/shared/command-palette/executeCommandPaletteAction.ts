import type { CommandPaletteCommandId } from '../../workspaces/commandPaletteCommands.js';
import type { WorkspaceInfo } from '../../../components/SpacesBrowser.js';
import { getMissingSelectionTitle, resolveSharedCommand } from './commands.js';
import type { CommandPaletteWorkspaceLike } from './workspace-selection.js';
import { showWorkspaceServiceSelect } from './showWorkspaceServiceSelect.js';

interface NotifyMessage {
  title: string;
  message: string;
  variant?: 'info' | 'success' | 'warning' | 'error';
}

interface ExecuteCommandPaletteActionArgs<T extends WorkspaceInfo & CommandPaletteWorkspaceLike> {
  commandId: CommandPaletteCommandId;
  workspace: T | null;
  projectName: string | null;
  showSelect: (config: {
    title: string;
    searchable?: boolean;
    options: Array<{ label: string; description?: string; value: string }>;
    onSelect: (value: string) => void | Promise<void>;
  }) => void;
  showMessage: (config: NotifyMessage) => void;
  onOpenUrl: (url: string) => void | Promise<void>;
  onAddRepo: () => void;
  onAddWorkspace: () => void;
  onSetStatus: (workspace: T) => void;
  onDeleteWorkspace: (workspace: T) => void;
  onEditBundleConfig: (workspace: T) => void | Promise<void>;
  onRefreshBundle: (workspace: T) => void | Promise<void>;
  onEditProcessConfig: (workspace: T) => void | Promise<void>;
  onDeleteRepo: (projectName: string) => void;
  onOpenGitHubPr?: (workspace: T) => void | Promise<void>;
  onOpenReview?: (workspace: T) => void | Promise<void>;
}

export function executeCommandPaletteAction<T extends WorkspaceInfo & CommandPaletteWorkspaceLike>(
  args: ExecuteCommandPaletteActionArgs<T>,
): void {
  const {
    commandId,
    workspace,
    projectName,
    showSelect,
    showMessage,
    onOpenUrl,
    onAddRepo,
    onAddWorkspace,
    onSetStatus,
    onDeleteWorkspace,
    onEditBundleConfig,
    onRefreshBundle,
    onEditProcessConfig,
    onDeleteRepo,
    onOpenGitHubPr,
    onOpenReview,
  } = args;

  if (commandId === 'open-github-pr') {
    if (workspace && onOpenGitHubPr) {
      void onOpenGitHubPr(workspace);
    } else {
      showMessage({
        title: getMissingSelectionTitle(commandId),
        message: 'Select a workspace on the board or in the list first.',
        variant: 'info',
      });
    }
    return;
  }

  if (commandId === 'open-review') {
    if (workspace && onOpenReview) {
      void onOpenReview(workspace);
    } else {
      showMessage({
        title: getMissingSelectionTitle(commandId),
        message: 'Select a workspace on the board or in the list first.',
        variant: 'info',
      });
    }
    return;
  }

  const sharedCommand = resolveSharedCommand(commandId, { workspace, projectName });
  switch (sharedCommand.kind) {
    case 'add-repo':
      onAddRepo();
      return;
    case 'add-workspace':
      onAddWorkspace();
      return;
    case 'set-status':
      onSetStatus(sharedCommand.workspace);
      return;
    case 'delete-workspace':
      onDeleteWorkspace(sharedCommand.workspace);
      return;
    case 'edit-bundle-config':
      void onEditBundleConfig(sharedCommand.workspace);
      return;
    case 'refresh-bundle':
      void onRefreshBundle(sharedCommand.workspace);
      return;
    case 'edit-process-config':
      void onEditProcessConfig(sharedCommand.workspace);
      return;
    case 'open-service':
      showWorkspaceServiceSelect({
        workspace: sharedCommand.workspace,
        showSelect,
        showMessage,
        onOpenUrl,
      });
      return;
    case 'delete-repo':
      onDeleteRepo(sharedCommand.projectName);
      return;
    case 'missing-workspace':
      showMessage({
        title: getMissingSelectionTitle(commandId),
        message: 'Select a workspace on the board or in the list first.',
        variant: 'info',
      });
      return;
    case 'missing-project':
      showMessage({
        title: 'Delete Repo',
        message: 'Select a project first.',
        variant: 'info',
      });
      return;
    case 'unhandled':
    default:
      return;
  }
}
