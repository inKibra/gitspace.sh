export interface CommandPaletteWorkspaceLike {
  id: string;
  projectName: string;
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

export function resolveSelectedWorkspace<T extends CommandPaletteWorkspaceLike>(
  args: ResolveSelectedWorkspaceArgs<T>,
): T | null {
  const workspaceId = resolveSelectedWorkspaceId(args);
  return workspaceId ? args.workspaces.find((workspace) => workspace.id === workspaceId) ?? null : null;
}

export function resolveSelectedProjectName(args: {
  selectedProjectName?: string | null;
}): string | null {
  return args.selectedProjectName ?? null;
}
