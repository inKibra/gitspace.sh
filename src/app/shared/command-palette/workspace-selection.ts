export interface CommandPaletteWorkspaceLike {
  id: string;
  projectName: string;
  /** Backend-scoped board selection key when the workspace comes from the kanban model. */
  selectionKey?: string;
}

export interface ResolveSelectedWorkspaceArgs<T extends CommandPaletteWorkspaceLike> {
  selectedBoardWorkspaceId?: string | null;
  selectedDetailWorkspaceId?: string | null;
  selectedBrowserWorkspaceId?: string | null;
  workspaces: T[];
}

function resolveSelectedWorkspaceId(args: ResolveSelectedWorkspaceArgs<CommandPaletteWorkspaceLike>): string | null {
  return args.selectedBoardWorkspaceId ?? args.selectedDetailWorkspaceId ?? args.selectedBrowserWorkspaceId ?? null;
}

function matchesSelectedWorkspace<T extends CommandPaletteWorkspaceLike>(workspace: T, selectedWorkspaceId: string): boolean {
  return workspace.id === selectedWorkspaceId || workspace.selectionKey === selectedWorkspaceId;
}

export function resolveSelectedWorkspace<T extends CommandPaletteWorkspaceLike>(
  args: ResolveSelectedWorkspaceArgs<T>,
): T | null {
  const workspaceId = resolveSelectedWorkspaceId(args);
  return workspaceId
    ? args.workspaces.find((workspace) => matchesSelectedWorkspace(workspace, workspaceId)) ?? null
    : null;
}

export function resolveSelectedProjectName(args: {
  selectedProjectName?: string | null;
}): string | null {
  return args.selectedProjectName ?? null;
}
