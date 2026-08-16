import { useCallback, useMemo } from 'react';
import type { WorkspaceInfo } from '../../components/SpacesBrowser.js';
import type { WorkspacePhase } from '../../types/config.js';
import { useCommandPaletteState, COMMAND_PALETTE_COMMAND_DEFS } from '../workspaces/index.js';
import { executeCommandPaletteAction } from '../shared/command-palette/executeCommandPaletteAction.js';
import { resolveSelectedProjectName, resolveSelectedWorkspace } from '../shared/command-palette/workspace-selection.js';
import { showWorkspaceStatusSelect } from '../shared/command-palette/workspace-status.js';
import type { CommandPaletteWorkspaceLike } from '../shared/command-palette/workspace-selection.js';

interface MessageConfig { title: string; message: string; variant?: 'info' | 'success' | 'warning' | 'error' }

export interface UseCommandPaletteOrchestrationOptions<T extends WorkspaceInfo & CommandPaletteWorkspaceLike> {
  selectedBoardWorkspaceId: string | null;
  selectedDetailWorkspaceId: string | null;
  workspaces: T[];
  selectedProjectName: string | null;
  showSelect: (config: { title: string; searchable?: boolean; options: Array<{ label: string; description?: string; value: string }>; onSelect: (value: any) => void | Promise<void> }) => void;
  showMessage: (config: MessageConfig) => void;
  onOpenUrl: (url: string) => void | Promise<void>;
  onAddRepo: () => void;
  onAddWorkspace: () => void;
  onSetWorkspacePhase: (workspace: T, phase: WorkspacePhase) => void;
  /** Optional: absent when the connection cannot roll up artifacts. */
  onRollupWorkspace?: (workspace: T) => void | Promise<void>;
  onDeleteWorkspace: (workspace: T) => void;
  onDeleteWorkspaceSkipScripts: (workspace: T) => void;
  onEditBundleConfig: (workspace: T) => void | Promise<void>;
  onRefreshBundle: (workspace: T) => void | Promise<void>;
  onRerunBundleScripts: (workspace: T) => void | Promise<void>;
  onAddNote: (workspace: T) => void | Promise<void>;
  onListNotes: (workspace: T) => void | Promise<void>;
  onEditProcessConfig: (workspace: T) => void | Promise<void>;
  onDeleteRepo: (projectName: string) => void;
  onOpenGitHubPr?: (workspace: T) => void | Promise<void>;
  onOpenReview?: (workspace: T) => void | Promise<void>;
  onOpenEditor?: (workspace: T) => void | Promise<void>;
  onShowGoalChains?: () => void | Promise<void>;
}

export function useCommandPaletteOrchestration<T extends WorkspaceInfo & CommandPaletteWorkspaceLike>(options: UseCommandPaletteOrchestrationOptions<T>) {
  const selectedWorkspace = useMemo(() => resolveSelectedWorkspace({
    selectedBoardWorkspaceId: options.selectedBoardWorkspaceId,
    selectedDetailWorkspaceId: options.selectedDetailWorkspaceId,
    workspaces: options.workspaces,
  }), [options.selectedBoardWorkspaceId, options.selectedDetailWorkspaceId, options.workspaces]);

  const selectedProjectName = useMemo(() => resolveSelectedProjectName({
    selectedProjectName: options.selectedProjectName,
  }), [options.selectedProjectName]);

  const handleSelect = useCallback((id: string) => {
    executeCommandPaletteAction({
      commandId: id as any,
      workspace: selectedWorkspace,
      projectName: selectedProjectName,
      showSelect: options.showSelect,
      showMessage: options.showMessage,
      onOpenUrl: options.onOpenUrl,
      onAddRepo: options.onAddRepo,
      onAddWorkspace: options.onAddWorkspace,
      onSetStatus: (workspace) => {
        showWorkspaceStatusSelect({
          showSelect: options.showSelect as any,
          onSelectPhase: (phase) => options.onSetWorkspacePhase(workspace, phase),
        });
      },
      onRollupWorkspace: options.onRollupWorkspace,
      onDeleteWorkspace: options.onDeleteWorkspace,
      onDeleteWorkspaceSkipScripts: options.onDeleteWorkspaceSkipScripts,
      onEditBundleConfig: options.onEditBundleConfig,
      onRefreshBundle: options.onRefreshBundle,
      onRerunBundleScripts: options.onRerunBundleScripts,
      onAddNote: options.onAddNote,
      onListNotes: options.onListNotes,
      onEditProcessConfig: options.onEditProcessConfig,
      onDeleteRepo: options.onDeleteRepo,
      onOpenGitHubPr: options.onOpenGitHubPr,
      onOpenReview: options.onOpenReview,
      onOpenEditor: options.onOpenEditor,
      onShowGoalChains: options.onShowGoalChains,
    });
  }, [options, selectedProjectName, selectedWorkspace]);

  const commands = useMemo(() => COMMAND_PALETTE_COMMAND_DEFS.map((d) => ({ id: d.id, label: d.label, shortcut: d.shortcut })), []);
  const commandPalette = useCommandPaletteState({ commands, onSelect: handleSelect });

  return { commandPalette, selectedWorkspace, selectedProjectName };
}
