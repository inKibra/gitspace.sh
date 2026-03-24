import type { WorkspaceStatusColor } from '../../workspaces/workspace-status.js';
import type { WorkspaceDetailStripStatus, WorkspaceDetailStripWorkspace } from '../../../components/WorkspaceDetailPane.js';

export type WorkspaceDetailStripDisplayItem<T extends WorkspaceDetailStripWorkspace> =
  | { type: 'workspace'; workspace: T }
  | { type: 'project-label'; projectName: string; tier: number };

function getWorkspaceStripTier(
  workspaceId: string,
  currentWorkspaceId: string,
  workspaceStatusById: Record<string, WorkspaceDetailStripStatus>,
): number {
  if (workspaceId === currentWorkspaceId) return -1;
  const color = workspaceStatusById[workspaceId]?.primaryColor;
  if (color === 'orange' || color === 'red') return 0;
  if (color === 'blue') return 1;
  if (color === 'green') return 2;
  return 3;
}

export function getWorkspaceStripColor(
  workspaceId: string,
  workspaceStatusById: Record<string, WorkspaceDetailStripStatus>,
): WorkspaceStatusColor {
  return workspaceStatusById[workspaceId]?.primaryColor ?? 'dim';
}

export function getVisibleWorkspaceDetailStripWorkspaces<T extends WorkspaceDetailStripWorkspace>(args: {
  workspaces: T[];
  currentWorkspaceId: string;
  workspaceStatusById: Record<string, WorkspaceDetailStripStatus>;
}): T[] {
  const { workspaces, currentWorkspaceId, workspaceStatusById } = args;

  return [...workspaces]
    .filter((workspace) => {
      if (workspace.id === currentWorkspaceId) return true;
      const color = workspaceStatusById[workspace.id]?.primaryColor;
      return color !== undefined && color !== 'dim';
    })
    .sort((a, b) => {
      const aTier = getWorkspaceStripTier(a.id, currentWorkspaceId, workspaceStatusById);
      const bTier = getWorkspaceStripTier(b.id, currentWorkspaceId, workspaceStatusById);
      if (aTier !== bTier) return aTier - bTier;
      const projectCompare = a.projectName.localeCompare(b.projectName);
      if (projectCompare !== 0) return projectCompare;
      return a.name.localeCompare(b.name);
    });
}

export function buildWorkspaceDetailStripDisplayItems<T extends WorkspaceDetailStripWorkspace>(args: {
  workspaces: T[];
  currentWorkspaceId: string;
  workspaceStatusById: Record<string, WorkspaceDetailStripStatus>;
}): WorkspaceDetailStripDisplayItem<T>[] {
  const orderedWorkspaces = getVisibleWorkspaceDetailStripWorkspaces(args);
  const items: WorkspaceDetailStripDisplayItem<T>[] = [];
  let lastProject: string | null = null;
  let lastTier: number | null = null;

  for (const workspace of orderedWorkspaces) {
    const tier = getWorkspaceStripTier(workspace.id, args.currentWorkspaceId, args.workspaceStatusById);
    if (tier === -1) {
      items.push({ type: 'workspace', workspace });
      continue;
    }
    if (workspace.projectName !== lastProject || tier !== lastTier) {
      items.push({ type: 'project-label', projectName: workspace.projectName, tier });
      lastProject = workspace.projectName;
      lastTier = tier;
    }
    items.push({ type: 'workspace', workspace });
  }

  return items;
}
