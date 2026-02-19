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

/** Process summary for workspace */
export interface WorkspaceProcessInfo {
  name: string;
  instances?: number;
  ports?: WorkspaceProcessPort[];
}

export interface WorkspaceProcessPort {
  port: number;
  name?: string;
  protocol?: 'http' | 'tcp';
}

/** Workspace info from machine */
export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
  projectName: string;
  branch?: string;
  sessionCount: number;
  isStale?: boolean;
  processes?: WorkspaceProcessInfo[];
  serveDomain?: string;
  processConfigError?: string;
}

/** Session info from machine */
export interface SessionInfo {
  id: string;
  name: string;
  workspaceId: string;
  attached: boolean;
  createdAt: number;
  processTitle?: string;
  processName?: string;
  processInstance?: number;
  exitCode?: number;
}

/** Tree item types for flattened list */
export type TreeItem =
  | { type: 'project'; name: string; workspaceCount: number }
  | { type: 'workspace'; workspace: WorkspaceInfo; expanded: boolean }
  | { type: 'session'; session: SessionInfo; workspaceId: string }
  | { type: 'process'; processName: string; instance: number; workspaceId: string; status: 'running' | 'stopped' | 'failed'; ports?: WorkspaceProcessPort[]; serveDomain?: string }
  | { type: 'process-config-error'; workspaceId: string; error: string }
  | { type: 'edit-processes'; workspaceId: string }
  | { type: 'events'; workspaceId: string }
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
  onRequestSessions: (workspaceId?: string) => void;
  onAttachSession: (params: { sessionId?: string; workspaceId?: string; viewOnly?: boolean }) => void | Promise<void>;
  onStartProcess?: (params: { workspaceId: string; processName: string }) => void;
  onStartProcessAttach: (params: { workspaceId: string; processName: string; instance: number }) => void;
  onStopProcess?: (params: { workspaceId: string; processName: string }) => void;
  onOpenEvents: (workspaceId: string) => void;
  onEditProcesses?: (params: { workspaceId: string }) => void;
  onRefresh: () => void | Promise<void>;
  /** Called to refresh sessions after workspace refresh (full refresh by default). */
  onRefreshSessions?: () => void | Promise<void>;
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
  activateSelected: () => Promise<void>;
  /** Direct attach - bypasses state timing issues on mobile */
  attachSession: (params: { sessionId?: string; workspaceId?: string }) => Promise<void>;
  startProcessAttach: (params: { workspaceId: string; processName: string; instance: number }) => void;
  startProcess: (params: { workspaceId: string; processName: string }) => void;
  stopProcess: (params: { workspaceId: string; processName: string }) => void;
  createNewSession: () => Promise<void>;
  createWorkspace: () => void;
  refresh: () => Promise<void>;
  openEvents: (workspaceId: string) => void;
  editProcesses: (params: { workspaceId: string }) => void;
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

      // If expanded, show processes, sessions, events, and new session action
      if (isExpanded) {
        const workspaceSessions = sessions
          .filter(s => s.workspaceId === ws.id)
          .sort((a, b) => {
            const aProcess = a.processName ? 0 : 1;
            const bProcess = b.processName ? 0 : 1;
            if (aProcess !== bProcess) return aProcess - bProcess;
            return a.name.localeCompare(b.name);
          });
        const processSessions = workspaceSessions.filter(s => s.processName);
        const adHocSessions = workspaceSessions.filter(s => !s.processName);

        // Build process entries from workspace config
        const processEntries = ws.processes ?? [];
        const renderedProcessKeys = new Set<string>();
        const processInstances = new Map<string, Set<number>>();
        for (const session of processSessions) {
          const instance = session.processInstance ?? 1;
          const set = processInstances.get(session.processName ?? '') || new Set<number>();
          set.add(instance);
          processInstances.set(session.processName ?? '', set);
        }

        for (const process of processEntries) {
          const knownInstances = processInstances.get(process.name) ?? new Set<number>();
          const configuredCount = process.instances ?? 1;
          const configuredInstances = Array.from({ length: configuredCount }, (_, idx) => idx + 1);
          const instanceList = configuredInstances.length > 0 ? configuredInstances : [1];
          for (const instance of instanceList) {
            const sessionMatch = processSessions.find(
              (session) => session.processName === process.name && (session.processInstance ?? 1) === instance
            );
            const exitCode = sessionMatch?.exitCode;
            const status = exitCode !== undefined
              ? exitCode === 0
                ? 'stopped'
                : 'failed'
              : knownInstances.has(instance)
                ? 'running'
                : 'stopped';
            items.push({
              type: 'process',
              processName: process.name,
              instance,
              workspaceId: ws.id,
              status,
              ports: process.ports,
              serveDomain: ws.serveDomain,
            });
            renderedProcessKeys.add(`${process.name}:${instance}`);
          }
        }

        // Process sessions not represented by process rows (orphaned/unconfigured)
        for (const session of processSessions) {
          const processKey = `${session.processName}:${session.processInstance ?? 1}`;
          if (renderedProcessKeys.has(processKey)) {
            continue;
          }
          items.push({
            type: 'session',
            session,
            workspaceId: ws.id,
          });
        }

        // Ad-hoc sessions
        for (const session of adHocSessions) {
          items.push({
            type: 'session',
            session,
            workspaceId: ws.id,
          });
        }

        if (ws.processConfigError) {
          items.push({
            type: 'process-config-error',
            workspaceId: ws.id,
            error: ws.processConfigError,
          });
        }

        // Edit processes config action
        items.push({
          type: 'edit-processes',
          workspaceId: ws.id,
        });

        // Events action
        items.push({
          type: 'events',
          workspaceId: ws.id,
        });

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
    onStartProcess,
    onStartProcessAttach,
    onStopProcess,
    onOpenEvents,
    onEditProcesses,
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

  const findSessionForProcess = useCallback(
    (workspaceId: string, processName: string, instance: number) =>
      sessions.find(
        (session) =>
          session.workspaceId === workspaceId &&
          session.processName === processName &&
          (session.processInstance ?? 1) === instance
      ),
    [sessions]
  );

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
    setExpandedWorkspaces(prev => {
      const next = new Set(prev);
      if (next.has(workspaceId)) {
        next.delete(workspaceId);
      } else {
        next.add(workspaceId);
        // Request a full sessions refresh when expanding.
        onRequestSessions();
      }
      return next;
    });
  }, [onRequestSessions]);

  const activateSelected = useCallback(async () => {
    if (!selectedItem) return;

    if (selectedItem.type === 'workspace') {
      toggleWorkspace(selectedItem.workspace.id);
    } else if (selectedItem.type === 'session') {
      await onAttachSession({ sessionId: selectedItem.session.id });
    } else if (selectedItem.type === 'process') {
      if (selectedItem.status === 'running') {
        const session = findSessionForProcess(
          selectedItem.workspaceId,
          selectedItem.processName,
          selectedItem.instance
        );
        if (session) {
          await onAttachSession({ sessionId: session.id, viewOnly: true });
        }
      } else {
        onStartProcessAttach({
          workspaceId: selectedItem.workspaceId,
          processName: selectedItem.processName,
          instance: selectedItem.instance,
        });
      }
    } else if (selectedItem.type === 'process-config-error') {
      onEditProcesses?.({ workspaceId: selectedItem.workspaceId });
    } else if (selectedItem.type === 'edit-processes') {
      onEditProcesses?.({ workspaceId: selectedItem.workspaceId });
    } else if (selectedItem.type === 'events') {
      onOpenEvents(selectedItem.workspaceId);
    } else if (selectedItem.type === 'new-session') {
      await onAttachSession({ workspaceId: selectedItem.workspaceId });
    }
  }, [selectedItem, toggleWorkspace, onAttachSession, onStartProcessAttach, findSessionForProcess, onEditProcesses, onOpenEvents]);

  const createNewSession = useCallback(async () => {
    if (!selectedItem) return;

    let workspaceId: string | null = null;
    if (selectedItem.type === 'workspace') {
      workspaceId = selectedItem.workspace.id;
    } else if (
      selectedItem.type === 'session' ||
      selectedItem.type === 'new-session' ||
      selectedItem.type === 'process-config-error'
    ) {
      workspaceId = selectedItem.workspaceId;
    }

    if (workspaceId) {
      await onAttachSession({ workspaceId });
    }
  }, [selectedItem, onAttachSession]);

  const createWorkspace = useCallback(() => {
    onCreateWorkspace?.();
  }, [onCreateWorkspace]);

  const refresh = useCallback(async () => {
    await onRefresh();
    // Also refresh sessions (shared full refresh policy)
    if (onRefreshSessions) {
      await onRefreshSessions();
    }
  }, [onRefresh, onRefreshSessions]);

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
    attachSession: async (params) => {
      await onAttachSession(params);
    },
    startProcessAttach: (params) => onStartProcessAttach(params),
    startProcess: (params) => onStartProcess?.(params),
    stopProcess: (params) => onStopProcess?.(params),
    createNewSession,
    createWorkspace,
    refresh,
    openEvents: (workspaceId) => onOpenEvents(workspaceId),
    editProcesses: (params) => onEditProcesses?.(params),
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
