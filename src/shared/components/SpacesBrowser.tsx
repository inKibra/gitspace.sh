/**
 * SpacesBrowser - Shared Hook
 *
 * Hook that manages workspace/session browser state and actions.
 * Used by both web and TUI renderers.
 */

import { useState, useCallback, useMemo, useEffect } from 'react';

// ============================================================================
// Types
// ============================================================================

/** Workspace info from machine */
export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
  projectName: string;
  branch?: string;
  sessionCount: number;
  isStale?: boolean;
}

/** Session info from machine */
export interface SessionInfo {
  id: string;
  name: string;
  workspaceId: string;
  attached: boolean;
  createdAt: number;
  processTitle?: string;
}

/** Tree item types for flattened list */
export type TreeItem =
  | { type: 'project'; name: string; workspaceCount: number }
  | { type: 'workspace'; workspace: WorkspaceInfo; expanded: boolean }
  | { type: 'session'; session: SessionInfo; workspaceId: string }
  | { type: 'new-session'; workspaceId: string };

/** Tree item with selection state */
export type TreeItemWithState = TreeItem & {
  isSelected: boolean;
  index: number;
};

/** Props for useSpacesBrowser hook */
export interface UseSpacesBrowserProps {
  workspaces: WorkspaceInfo[];
  sessions: SessionInfo[];
  onRequestSessions: (workspaceId: string) => void;
  onAttachSession: (params: { sessionId?: string; workspaceId?: string }) => void;
  onRefresh: () => void;
  /** Called to refresh sessions for specific workspaces (e.g., on manual refresh) */
  onRefreshSessions?: (workspaceIds: string[]) => void;
  onBack: () => void;
  /** Called when user wants to create a new workspace */
  onCreateWorkspace?: () => void;
  machineName?: string;
  /** Whether to show project headers in the tree. Default true. */
  showProjectHeaders?: boolean;
}

/** Return type of useSpacesBrowser hook */
export interface UseSpacesBrowserReturn {
  // Display data
  items: TreeItemWithState[];
  selectedIndex: number;
  selectedItem: TreeItem | null;
  expandedWorkspaces: Set<string>;
  machineName: string | null;

  // Computed flags
  isEmpty: boolean;

  // Actions
  moveUp: () => void;
  moveDown: () => void;
  selectIndex: (index: number) => void;
  toggleWorkspace: (workspaceId: string) => void;
  activateSelected: () => void;
  /** Direct attach - bypasses state timing issues on mobile */
  attachSession: (params: { sessionId?: string; workspaceId?: string }) => void;
  createNewSession: () => void;
  createWorkspace: () => void;
  refresh: () => void;
  back: () => void;
}

// ============================================================================
// Tree Building
// ============================================================================

interface ProjectGroup {
  name: string;
  workspaces: WorkspaceInfo[];
}

function groupByProject(workspaces: WorkspaceInfo[]): ProjectGroup[] {
  const projectMap = new Map<string, WorkspaceInfo[]>();

  for (const ws of workspaces) {
    const list = projectMap.get(ws.projectName) || [];
    list.push(ws);
    projectMap.set(ws.projectName, list);
  }

  const groups: ProjectGroup[] = [];
  for (const [name, wsList] of projectMap) {
    groups.push({ name, workspaces: wsList });
  }

  return groups;
}

function buildTree(
  workspaces: WorkspaceInfo[],
  sessions: SessionInfo[],
  expandedWorkspaces: Set<string>,
  showProjectHeaders: boolean = true
): TreeItem[] {
  const items: TreeItem[] = [];
  const projectGroups = groupByProject(workspaces);

  for (const group of projectGroups) {
    // Project header (optional)
    if (showProjectHeaders) {
      items.push({
        type: 'project',
        name: group.name,
        workspaceCount: group.workspaces.length,
      });
    }

    // Workspaces under this project
    for (const ws of group.workspaces) {
      const isExpanded = expandedWorkspaces.has(ws.id);
      items.push({
        type: 'workspace',
        workspace: ws,
        expanded: isExpanded,
      });

      // If expanded, show sessions and new session action
      if (isExpanded) {
        const workspaceSessions = sessions.filter(s => s.workspaceId === ws.id);
        for (const session of workspaceSessions) {
          items.push({
            type: 'session',
            session,
            workspaceId: ws.id,
          });
        }
        // New session action
        items.push({
          type: 'new-session',
          workspaceId: ws.id,
        });
      }
    }
  }

  return items;
}

function addSelectionState(items: TreeItem[], selectedIndex: number): TreeItemWithState[] {
  return items.map((item, index) => ({
    ...item,
    isSelected: index === selectedIndex,
    index,
  }));
}

// ============================================================================
// Hook
// ============================================================================

export function useSpacesBrowser(props: UseSpacesBrowserProps): UseSpacesBrowserReturn {
  const {
    workspaces,
    sessions,
    onRequestSessions,
    onAttachSession,
    onRefresh,
    onRefreshSessions,
    onBack,
    onCreateWorkspace,
    machineName,
    showProjectHeaders = true,
  } = props;

  // Local UI state
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(new Set());

  // Build tree
  const tree = useMemo(
    () => buildTree(workspaces, sessions, expandedWorkspaces, showProjectHeaders),
    [workspaces, sessions, expandedWorkspaces, showProjectHeaders]
  );

  // Add selection state
  const items = useMemo(
    () => addSelectionState(tree, selectedIndex),
    [tree, selectedIndex]
  );

  // Selected item
  const selectedItem = tree[selectedIndex] ?? null;

  // Computed
  const isEmpty = workspaces.length === 0;

  // Clamp selection when tree changes
  useEffect(() => {
    if (selectedIndex >= tree.length && tree.length > 0) {
      setSelectedIndex(tree.length - 1);
    }
  }, [tree.length, selectedIndex]);

  // Actions
  const moveUp = useCallback(() => {
    setSelectedIndex(i => Math.max(0, i - 1));
  }, []);

  const moveDown = useCallback(() => {
    setSelectedIndex(i => Math.min(tree.length - 1, i + 1));
  }, [tree.length]);

  const selectIndex = useCallback((index: number) => {
    setSelectedIndex(Math.max(0, Math.min(index, tree.length - 1)));
  }, [tree.length]);

  const toggleWorkspace = useCallback((workspaceId: string) => {
    console.log('[SpacesBrowser hook] toggleWorkspace called:', workspaceId);
    setExpandedWorkspaces(prev => {
      const next = new Set(prev);
      if (next.has(workspaceId)) {
        console.log('[SpacesBrowser hook] Collapsing workspace:', workspaceId);
        next.delete(workspaceId);
      } else {
        console.log('[SpacesBrowser hook] Expanding workspace:', workspaceId);
        next.add(workspaceId);
        // Request sessions when expanding
        onRequestSessions(workspaceId);
      }
      return next;
    });
  }, [onRequestSessions]);

  const activateSelected = useCallback(() => {
    if (!selectedItem) return;

    if (selectedItem.type === 'workspace') {
      toggleWorkspace(selectedItem.workspace.id);
    } else if (selectedItem.type === 'session') {
      onAttachSession({ sessionId: selectedItem.session.id });
    } else if (selectedItem.type === 'new-session') {
      onAttachSession({ workspaceId: selectedItem.workspaceId });
    }
  }, [selectedItem, toggleWorkspace, onAttachSession]);

  const createNewSession = useCallback(() => {
    if (!selectedItem) return;

    let workspaceId: string | null = null;
    if (selectedItem.type === 'workspace') {
      workspaceId = selectedItem.workspace.id;
    } else if (selectedItem.type === 'session' || selectedItem.type === 'new-session') {
      workspaceId = selectedItem.workspaceId;
    }

    if (workspaceId) {
      onAttachSession({ workspaceId });
    }
  }, [selectedItem, onAttachSession]);

  const createWorkspace = useCallback(() => {
    onCreateWorkspace?.();
  }, [onCreateWorkspace]);

  const refresh = useCallback(() => {
    console.log("[SpacesBrowser] refresh() called, expandedWorkspaces:", expandedWorkspaces.size);
    onRefresh();
    // Also refresh sessions for all expanded workspaces
    if (onRefreshSessions && expandedWorkspaces.size > 0) {
      onRefreshSessions(Array.from(expandedWorkspaces));
    }
  }, [onRefresh, onRefreshSessions, expandedWorkspaces]);

  const back = useCallback(() => {
    onBack();
  }, [onBack]);

  return {
    // Display data
    items,
    selectedIndex,
    selectedItem,
    expandedWorkspaces,
    machineName: machineName ?? null,

    // Computed flags
    isEmpty,

    // Actions
    moveUp,
    moveDown,
    selectIndex,
    toggleWorkspace,
    activateSelected,
    attachSession: onAttachSession,
    createNewSession,
    createWorkspace,
    refresh,
    back,
  };
}

// ============================================================================
// Utilities
// ============================================================================

/** Format timestamp for display */
export function formatTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60000) return 'now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  return `${Math.floor(diff / 86400000)}d`;
}
