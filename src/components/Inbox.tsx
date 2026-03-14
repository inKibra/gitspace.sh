/**
 * Inbox - Shared Hook
 *
 * Hook that manages inbox notification state and actions.
 * Used by both web and TUI renderers.
 */

import { useState, useCallback, useMemo, useEffect } from 'react';

// ============================================================================
// Types
// ============================================================================

/** Inbox item type */
export type InboxItemType =
  | 'exit' | 'title' | 'idle' | 'bell' | 'osc'
  | 'agent_permission' | 'agent_idle' | 'agent_error';

/** Inbox item from tmux-lite or agent notification system */
export interface InboxItem {
  id: string;
  sessionId: string;
  sessionName: string;
  type: InboxItemType;
  context: string;
  timestamp: number;
  read: boolean;
  processTitle?: string;
  exitCode?: number;
  /** Present only for agent_* item types — carries routing metadata for the app layer */
  agentAction?: {
    workspaceId: string;
    agentSessionId: string;
    permissionId?: string;
    permissionTitle?: string;
    messagePreview?: string;
  };
}

/** Parsed session name components */
export interface ParsedSessionName {
  project: string;
  workspace: string;
  session: string;
}

/** Session group in hierarchical view */
export interface SessionGroup {
  session: string;
  items: InboxItem[];
}

/** Workspace group in hierarchical view */
export interface WorkspaceGroup {
  workspace: string;
  sessions: SessionGroup[];
  totalItems: number;
}

/** Project group in hierarchical view */
export interface ProjectGroup {
  project: string;
  workspaces: WorkspaceGroup[];
  totalItems: number;
}

/** Display item types for flattened list */
export type InboxDisplayItem =
  | { type: 'project-header'; project: string; totalItems: number }
  | { type: 'workspace-header'; workspace: string; itemCount: number; isFirstWorkspace: boolean }
  | { type: 'session-header'; session: string; itemCount: number; isFirstSession: boolean }
  | { type: 'item'; item: InboxItem; flatIndex: number };

/** Props for useInbox hook */
export interface UseInboxProps {
  items: InboxItem[];
  unreadCount: number;
  onClearItem: (itemId: string) => Promise<void>;
  onClearAll: () => Promise<void>;
  onMarkRead: (itemId: string) => Promise<void>;
  onAttachSession: (sessionId: string) => Promise<void>;
  onClose: () => void;
}

/** Return type of useInbox hook */
export interface UseInboxReturn {
  // Display data
  displayItems: InboxDisplayItem[];
  flatItems: InboxItem[];
  hierarchical: ProjectGroup[];
  selectedIndex: number;
  viewingSessionId: string | null;
  sessionThreadItems: InboxItem[];
  unreadCount: number;

  // Computed flags
  isEmpty: boolean;
  isViewingThread: boolean;

  // Actions
  moveUp: () => void;
  moveDown: () => void;
  selectIndex: (index: number) => void;
  openThread: () => void;
  closeThread: () => void;
  deleteSelected: () => Promise<void>;
  deleteThread: () => Promise<void>;
  clearAll: () => Promise<void>;
  attachToSession: () => Promise<void>;
  close: () => void;
}

// ============================================================================
// Helpers
// ============================================================================

/** Parse session name into project/workspace/session */
export function parseSessionName(sessionName: string): ParsedSessionName {
  if (!sessionName || typeof sessionName !== 'string') {
    return { project: 'unknown', workspace: 'unknown', session: 'unknown' };
  }
  const parts = sessionName.split(':');
  // Handle agent:<title> session segment — parts may be: project:workspace:agent:<title>
  // where the title itself may contain colons. Join everything from index 2 onward.
  const sessionPart = parts.slice(2).join(':') || 'unknown';
  return {
    project: parts[0] || 'unknown',
    workspace: parts[1] || 'unknown',
    session: sessionPart,
  };
}

/** Get icon for inbox item type */
export function getInboxIcon(item: InboxItem): string {
  if (item.type === 'exit') return item.exitCode === 0 ? '✅' : '❌';
  if (item.type === 'title') return '📝';
  if (item.type === 'idle') return '⏸️';
  if (item.type === 'osc') return '📟';
  if (item.type === 'agent_permission') return '⚡';
  if (item.type === 'agent_idle') return '💬';
  if (item.type === 'agent_error') return '🤖';
  return '🔔';
}

/** Returns true if the item is an agent notification type */
export function isAgentInboxItem(item: InboxItem): item is InboxItem & { agentAction: NonNullable<InboxItem['agentAction']> } {
  return (item.type === 'agent_permission' || item.type === 'agent_idle' || item.type === 'agent_error')
    && item.agentAction != null;
}

/** Get label for inbox item type */
export function getInboxTypeLabel(item: InboxItem): string {
  if (item.type === 'exit') return item.exitCode === 0 ? 'Completed' : `Exit code ${item.exitCode}`;
  if (item.type === 'title') return 'Title Change';
  if (item.type === 'idle') return 'Activity Complete';
  if (item.type === 'osc') return 'OSC Notification';
  if (item.type === 'agent_permission') return 'Permission Request';
  if (item.type === 'agent_idle') return 'Agent Done';
  if (item.type === 'agent_error') return 'Agent Error';
  return 'Bell';
}

/** Format relative time */
export function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Group inbox items hierarchically by project > workspace > session */
function groupInboxHierarchically(items: InboxItem[]): ProjectGroup[] {
  // Filter out invalid items and sort by timestamp (most recent first)
  const validItems = items.filter(item =>
    item &&
    typeof item === 'object' &&
    item.sessionName &&
    typeof item.sessionName === 'string' &&
    item.sessionName !== 'undefined'
  );
  const sortedItems = [...validItems].sort((a, b) => b.timestamp - a.timestamp);

  // Three-level grouping: project → workspace → session
  const projectMap = new Map<string, Map<string, Map<string, InboxItem[]>>>();
  const projectLatest = new Map<string, number>();
  const workspaceLatest = new Map<string, number>();
  const sessionLatest = new Map<string, number>();

  for (const item of sortedItems) {
    const { project, workspace, session } = parseSessionName(item.sessionName);
    const wsKey = `${project}:${workspace}`;
    const sessKey = `${project}:${workspace}:${session}`;

    // Track latest timestamp for sorting groups
    if (!projectLatest.has(project) || item.timestamp > projectLatest.get(project)!) {
      projectLatest.set(project, item.timestamp);
    }
    if (!workspaceLatest.has(wsKey) || item.timestamp > workspaceLatest.get(wsKey)!) {
      workspaceLatest.set(wsKey, item.timestamp);
    }
    if (!sessionLatest.has(sessKey) || item.timestamp > sessionLatest.get(sessKey)!) {
      sessionLatest.set(sessKey, item.timestamp);
    }

    if (!projectMap.has(project)) {
      projectMap.set(project, new Map());
    }
    const workspaceMap = projectMap.get(project)!;

    if (!workspaceMap.has(workspace)) {
      workspaceMap.set(workspace, new Map());
    }
    const sessionMap = workspaceMap.get(workspace)!;

    if (!sessionMap.has(session)) {
      sessionMap.set(session, []);
    }
    sessionMap.get(session)!.push(item);
  }

  const result: ProjectGroup[] = [];
  for (const [project, workspaceMap] of projectMap) {
    const workspaces: WorkspaceGroup[] = [];
    let projectTotal = 0;

    for (const [workspace, sessionMap] of workspaceMap) {
      const sessions: SessionGroup[] = [];
      let workspaceTotal = 0;

      for (const [session, sessionItems] of sessionMap) {
        sessions.push({ session, items: sessionItems });
        workspaceTotal += sessionItems.length;
      }

      // Sort sessions by most recent
      const wsKey = `${project}:${workspace}`;
      sessions.sort((a, b) => {
        const aKey = `${wsKey}:${a.session}`;
        const bKey = `${wsKey}:${b.session}`;
        return (sessionLatest.get(bKey) || 0) - (sessionLatest.get(aKey) || 0);
      });

      workspaces.push({ workspace, sessions, totalItems: workspaceTotal });
      projectTotal += workspaceTotal;
    }

    // Sort workspaces by most recent
    workspaces.sort((a, b) => {
      const aKey = `${project}:${a.workspace}`;
      const bKey = `${project}:${b.workspace}`;
      return (workspaceLatest.get(bKey) || 0) - (workspaceLatest.get(aKey) || 0);
    });

    result.push({ project, workspaces, totalItems: projectTotal });
  }

  // Sort projects by most recent
  result.sort((a, b) => (projectLatest.get(b.project) || 0) - (projectLatest.get(a.project) || 0));

  return result;
}

/** Build flat display items from hierarchical groups */
function buildInboxDisplay(items: InboxItem[]): { displayItems: InboxDisplayItem[]; flatItems: InboxItem[] } {
  const hierarchical = groupInboxHierarchically(items);
  const displayItems: InboxDisplayItem[] = [];
  const flatItems: InboxItem[] = [];
  let flatIndex = 0;

  for (const projectGroup of hierarchical) {
    displayItems.push({
      type: 'project-header',
      project: projectGroup.project,
      totalItems: projectGroup.totalItems,
    });

    projectGroup.workspaces.forEach((wsGroup, wsIdx) => {
      displayItems.push({
        type: 'workspace-header',
        workspace: wsGroup.workspace,
        itemCount: wsGroup.totalItems,
        isFirstWorkspace: wsIdx === 0,
      });

      wsGroup.sessions.forEach((sessGroup, sessIdx) => {
        displayItems.push({
          type: 'session-header',
          session: sessGroup.session,
          itemCount: sessGroup.items.length,
          isFirstSession: sessIdx === 0,
        });

        for (const item of sessGroup.items) {
          displayItems.push({ type: 'item', item, flatIndex });
          flatItems.push(item);
          flatIndex++;
        }
      });
    });
  }

  return { displayItems, flatItems };
}

/** Get items for a specific session thread */
function getSessionItems(items: InboxItem[], sessionId: string): InboxItem[] {
  return items
    .filter((item) => item.sessionId === sessionId)
    .sort((a, b) => b.timestamp - a.timestamp);
}

// ============================================================================
// Hook
// ============================================================================

export function useInbox(props: UseInboxProps): UseInboxReturn {
  const {
    items,
    unreadCount,
    onClearItem,
    onClearAll,
    onMarkRead,
    onAttachSession,
    onClose,
  } = props;

  // Local UI state
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [viewingSessionId, setViewingSessionId] = useState<string | null>(null);

  // Build display data
  const { displayItems, flatItems } = useMemo(
    () => buildInboxDisplay(items),
    [items]
  );

  const hierarchical = useMemo(
    () => groupInboxHierarchically(items),
    [items]
  );

  // Session thread items (when viewing a thread)
  const sessionThreadItems = useMemo(
    () => (viewingSessionId ? getSessionItems(items, viewingSessionId) : []),
    [items, viewingSessionId]
  );

  // Computed
  const isEmpty = items.length === 0;
  const isViewingThread = viewingSessionId !== null;

  // Clamp selectedIndex when items change
  useEffect(() => {
    if (flatItems.length === 0) {
      setSelectedIndex(0);
    } else if (selectedIndex >= flatItems.length) {
      setSelectedIndex(Math.max(0, flatItems.length - 1));
    }
  }, [flatItems.length, selectedIndex]);

  // Actions
  const moveUp = useCallback(() => {
    setSelectedIndex((i) => Math.max(0, i - 1));
  }, []);

  const moveDown = useCallback(() => {
    if (flatItems.length === 0) return; // Don't move if no items
    setSelectedIndex((i) => Math.min(flatItems.length - 1, i + 1));
  }, [flatItems.length]);

  const selectIndex = useCallback(
    (index: number) => {
      setSelectedIndex(Math.max(0, Math.min(index, flatItems.length - 1)));
    },
    [flatItems.length]
  );

  const openThread = useCallback(async () => {
    if (flatItems.length === 0) return;

    const item = flatItems[selectedIndex];
    if (item) {
      // Mark thread as read
      const threadItems = items.filter((i) => i.sessionId === item.sessionId && !i.read);
      for (const threadItem of threadItems) {
        await onMarkRead(threadItem.id);
      }
      setViewingSessionId(item.sessionId);
    }
  }, [flatItems, selectedIndex, items, onMarkRead]);

  const closeThread = useCallback(() => {
    setViewingSessionId(null);
  }, []);

  const deleteSelected = useCallback(async () => {
    if (flatItems.length === 0) return;

    const item = flatItems[selectedIndex];
    if (item) {
      await onClearItem(item.id);
      // Adjust selection if needed
      if (selectedIndex >= flatItems.length - 1 && flatItems.length > 1) {
        setSelectedIndex(flatItems.length - 2);
      }
    }
  }, [flatItems, selectedIndex, onClearItem]);

  const deleteThread = useCallback(async () => {
    if (!viewingSessionId) return;

    for (const item of sessionThreadItems) {
      await onClearItem(item.id);
    }
    // Adjust selection and go back to list
    const newFlatItems = flatItems.filter((i) => i.sessionId !== viewingSessionId);
    const newIndex = selectedIndex >= newFlatItems.length ? Math.max(0, newFlatItems.length - 1) : selectedIndex;
    setSelectedIndex(newIndex);
    setViewingSessionId(null);
  }, [viewingSessionId, sessionThreadItems, flatItems, selectedIndex, onClearItem]);

  const clearAll = useCallback(async () => {
    await onClearAll();
    setSelectedIndex(0);
    setViewingSessionId(null);
  }, [onClearAll]);

  const attachToSession = useCallback(async () => {
    const sessionId = viewingSessionId || (flatItems[selectedIndex]?.sessionId);
    if (sessionId) {
      await onAttachSession(sessionId);
    }
  }, [viewingSessionId, flatItems, selectedIndex, onAttachSession]);

  const close = useCallback(() => {
    if (viewingSessionId) {
      setViewingSessionId(null);
    } else {
      onClose();
    }
  }, [viewingSessionId, onClose]);

  return {
    // Display data
    displayItems,
    flatItems,
    hierarchical,
    selectedIndex,
    viewingSessionId,
    sessionThreadItems,
    unreadCount,

    // Computed flags
    isEmpty,
    isViewingThread,

    // Actions
    moveUp,
    moveDown,
    selectIndex,
    openThread,
    closeThread,
    deleteSelected,
    deleteThread,
    clearAll,
    attachToSession,
    close,
  };
}
