/**
 * SpacesBrowser - Shared Hook
 *
 * Hook that manages workspace/session browser state and actions.
 * Used by both web and TUI renderers.
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import { normalizeProcessInstanceCount } from '../lib/processes/instances.js';
import type { ReplayInfo } from '../lib/tmux-lite/replay/index.js';
import type {
  MachineWorkspaceLinearRecord,
  MachineWorkspacePullRequestRecord,
} from '../lib/tmux-lite/machine/types.js';
import type { AgentSessionInfo } from '../machine/api/list-types.js';
import type { WorkspaceRuntimeEntry } from '../app/shared/workspace-runtime/types.js';
import type { WorkspaceNotesSummary } from '../types/workspace.js';
import type { RuntimeProcessDefinition, ResolvedProcessPort } from '../types/processes.js';
import { getProcessPortsForInstance } from '../lib/processes/runtime-ports.js';
export type { AgentSessionInfo } from '../machine/api/list-types.js';

export type { ReplayInfo };

// ============================================================================
// Types
// ============================================================================

/** Process summary for workspace */
export type WorkspaceProcessInfo = RuntimeProcessDefinition;
export type WorkspaceProcessPort = ResolvedProcessPort;

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
  pullRequest?: MachineWorkspacePullRequestRecord;
  linear?: MachineWorkspaceLinearRecord;
  notesSummary?: WorkspaceNotesSummary;
}

/** Session info from machine */
export interface SessionInfo {
  id: string;
  name: string;
  workspaceId: string;
  attached: boolean;
  createdAt: number;
  processTitle?: string;
  terminalTitle?: string;
  lastAlertKind?: import('../lib/tmux-lite/protocol.js').InboxItem['type'];
  lastAlertPreview?: string;
  lastAlertAt?: number;
  unreadAlertCount?: number;
  processName?: string;
  processInstance?: number;
  exitCode?: number;
}


export type AgentSessionDisplayState =
  | 'closed'
  | 'needs-permission'
  | 'error'
  | 'running'
  | 'retrying'
  | 'waiting';

export function getAgentSessionDisplayState(session: AgentSessionInfo): AgentSessionDisplayState {
  if (session.closedAt) {
    return 'closed';
  }
  if ((session.pendingPermissionCount ?? 0) > 0 || (session.pendingQuestionCount ?? 0) > 0) {
    return 'needs-permission';
  }
  if (session.errorMessage) {
    return 'error';
  }
  if (session.status?.type === 'busy') {
    return 'running';
  }
  if (session.status?.type === 'retry') {
    return 'retrying';
  }
  return 'waiting';
}

export function getAgentSessionDisplayLabel(session: AgentSessionInfo): string {
  const state = getAgentSessionDisplayState(session);
  switch (state) {
    case 'closed':
      return 'closed';
    case 'needs-permission':
      return `needs permission${(session.pendingPermissionCount ?? 0) > 1 ? ` (${session.pendingPermissionCount})` : ''}`;
    case 'error':
      return 'error';
    case 'running':
      return 'running';
    case 'retrying':
      return 'retrying';
    case 'waiting':
    default:
      return 'waiting';
  }
}

/** Tree item types for flattened list */
export type TreeItem =
  | { type: 'project'; name: string; workspaceCount: number }
  | { type: 'workspace'; workspace: WorkspaceInfo; expanded: boolean }
  | { type: 'agents'; workspaceId: string; count?: number; pendingPermissions?: number; expanded: boolean }
  | { type: 'agent-session'; session: AgentSessionInfo; workspaceId: string }
  | { type: 'new-agent-session'; workspaceId: string }
  | { type: 'session'; session: SessionInfo; workspaceId: string; subtitle?: string; alertLabel?: string }
  | { type: 'replay-section'; workspaceId: string; count: number; expanded: boolean }
  | { type: 'orphaned-replay-section'; projectName: string; count: number; expanded: boolean }
  | { type: 'replay'; replay: ReplayInfo; workspaceId: string }
  | { type: 'process'; processName: string; instance: number; workspaceId: string; status: 'running' | 'stopped' | 'failed'; ports?: WorkspaceProcessPort[]; serveDomain?: string; subtitle?: string; alertLabel?: string; attachableSessionId?: string }
  | { type: 'process-disabled'; processName: string; workspaceId: string; ports?: WorkspaceProcessPort[] }
  | { type: 'process-config-error'; workspaceId: string; error: string }
  | { type: 'edit-processes'; workspaceId: string }
  | { type: 'bundle-config'; workspaceId: string }
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
  replays: ReplayInfo[];
  onAttachSession: (params: { sessionId?: string; workspaceId?: string; viewOnly?: boolean }) => void | Promise<void>;
  onOpenReplay: (replayId: string) => void | Promise<void>;
  onStartProcessAttach: (params: { workspaceId: string; processName: string; instance: number }) => void;
  onStopProcess?: (params: { workspaceId: string; processName: string }) => void;
  onProcessDisabled?: (params: { workspaceId: string; processName: string }) => void;
  onOpenEvents: (workspaceId: string) => void;
  onOpenAgents?: (workspaceId: string) => void | Promise<void>;
  onOpenAgentSession?: (workspaceId: string, agentSessionId: string) => void | Promise<void>;
  onCreateAgentSession?: (workspaceId: string) => void | Promise<void>;
  agentSessionsByWorkspace?: Record<string, AgentSessionInfo[]>;
  agentSessionCounts?: Record<string, number>;
  /** Pending permission count per workspace, from useWorkspaceAgentEvents */
  pendingPermissionsByWorkspace?: Record<string, number>;
  runtimeByWorkspace?: Record<string, WorkspaceRuntimeEntry>;
  onEditProcesses?: (params: { workspaceId: string }) => void;
  onManageBundleConfig?: (params: { workspaceId: string }) => void;
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
  expandedAgentSections: Set<string>;
  machineName: string | null;

  // Computed flags
  isEmpty: boolean;

  // Actions
  moveUp: () => void;
  moveDown: () => void;
  selectIndex: (index: number) => void;
  toggleWorkspace: (workspaceId: string) => void;
  toggleAgentSection: (workspaceId: string) => void;
  activateSelected: () => Promise<void>;
  activateIndex: (index: number) => Promise<void>;
  /** Direct attach - bypasses state timing issues on mobile */
  attachSession: (params: { sessionId?: string; workspaceId?: string; viewOnly?: boolean }) => Promise<void>;
  openReplay: (replayId: string) => Promise<void>;
  startProcessAttach: (params: { workspaceId: string; processName: string; instance: number }) => void;
  stopProcess: (params: { workspaceId: string; processName: string }) => void;
  createNewSession: () => Promise<void>;
  createWorkspace: () => void;
  refresh: () => Promise<void>;
  openEvents: (workspaceId: string) => void;
  editProcesses: (params: { workspaceId: string }) => void;
  manageBundleConfig: (params: { workspaceId: string }) => void;
  back: () => void;
}

// ============================================================================
// Tree Building
// ============================================================================

interface ProjectGroup {
  name: string;
  workspaces: WorkspaceInfo[];
}

function groupByProject(workspaces: WorkspaceInfo[], replays: ReplayInfo[]): ProjectGroup[] {
  const projectMap = new Map<string, WorkspaceInfo[]>();

  for (const ws of workspaces) {
    const list = projectMap.get(ws.projectName) || [];
    list.push(ws);
    projectMap.set(ws.projectName, list);
  }

  for (const replay of replays) {
    const projectName = replay.projectName ?? 'Unknown';
    if (!projectMap.has(projectName)) {
      projectMap.set(projectName, []);
    }
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
  replays: ReplayInfo[],
  expandedWorkspaces: Set<string>,
  expandedAgentSections: Set<string>,
  expandedReplaySections: Set<string>,
  agentSessionCounts: Record<string, number>,
  showProjectHeaders: boolean = true,
  agentSessionsByWorkspace: Record<string, AgentSessionInfo[]> = {},
  pendingPermissionsByWorkspace: Record<string, number> = {},
  runtimeByWorkspace: Record<string, WorkspaceRuntimeEntry> = {},
): TreeItem[] {
  const items: TreeItem[] = [];
  const projectGroups = groupByProject(workspaces, replays);

  const sortWorkspaceSessions = (workspaceSessions: SessionInfo[]): SessionInfo[] => (
    [...workspaceSessions].sort((a, b) => {
      const aProcess = a.processName ? 0 : 1;
      const bProcess = b.processName ? 0 : 1;
      if (aProcess !== bProcess) return aProcess - bProcess;
      return a.name.localeCompare(b.name);
    })
  );

  for (const group of projectGroups) {
    const workspaceIds = new Set(group.workspaces.map((workspace) => workspace.id));
    const orphanedProjectReplays = replays
      .filter((replay) => (replay.projectName ?? 'Unknown') === group.name && !workspaceIds.has(replay.workspaceId ?? ''))
      .sort((a, b) => b.startedAt - a.startedAt);

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
        const runtime = runtimeByWorkspace[ws.id];
        const workspaceSessions = runtime?.sessions ?? sortWorkspaceSessions(sessions.filter((session) => session.workspaceId === ws.id));
        const processSessions = runtime?.processSessions ?? workspaceSessions.filter((session) => session.processName);
        const adHocSessions = runtime?.shellSessions ?? workspaceSessions.filter((session) => !session.processName);
        const renderedProcessKeys = new Set<string>();

        if (runtime) {
          for (const row of runtime.processRows) {
            if (row.state === 'disabled') {
              items.push({
                type: 'process-disabled',
                processName: row.processName,
                workspaceId: ws.id,
                ports: ws.processes?.find((process) => process.name === row.processName)?.ports,
              });
              continue;
            }
            items.push({
              type: 'process',
              processName: row.processName,
              instance: row.instance,
              workspaceId: ws.id,
              status: row.state,
              ports: getProcessPortsForInstance(
                ws.processes?.find((process) => process.name === row.processName)?.ports,
                row.instance,
              ),
              serveDomain: ws.serveDomain,
              subtitle: row.subtitle,
              alertLabel: row.alertLabel,
              attachableSessionId: row.attachableSessionId,
            });
            renderedProcessKeys.add(`${row.processName}:${row.instance}`);
          }
        } else {
          const processEntries = ws.processes ?? [];
          const processSessionGroups = new Map<string, SessionInfo[]>();
          for (const session of processSessions) {
            const key = `${session.processName ?? ''}:${session.processInstance ?? 1}`;
            const existing = processSessionGroups.get(key) ?? [];
            existing.push(session);
            processSessionGroups.set(key, existing);
          }
          const getLatestSession = (items: SessionInfo[]): SessionInfo | null => {
            if (items.length === 0) return null;
            return [...items].sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
          };
          for (const process of processEntries) {
            const configuredCount = normalizeProcessInstanceCount(process.instances);
            if (configuredCount === 0) {
              items.push({
                type: 'process-disabled',
                processName: process.name,
                workspaceId: ws.id,
                ports: process.ports,
              });
              continue;
            }
            for (let instance = 1; instance <= configuredCount; instance += 1) {
              const sessionKey = `${process.name}:${instance}`;
              const matchingSessions = processSessionGroups.get(sessionKey) ?? [];
              const runningSession = getLatestSession(matchingSessions.filter((session) => session.exitCode === undefined));
              const latestSession = getLatestSession(matchingSessions);
              let status: 'running' | 'stopped' | 'failed' = 'stopped';
              if (runningSession) {
                status = 'running';
              } else if (latestSession?.exitCode !== undefined) {
                status = latestSession.exitCode === 0 ? 'stopped' : 'failed';
              }
              items.push({
                type: 'process',
                processName: process.name,
                instance,
                workspaceId: ws.id,
                status,
                ports: getProcessPortsForInstance(process.ports, instance),
                serveDomain: ws.serveDomain,
              });
              renderedProcessKeys.add(`${process.name}:${instance}`);
            }
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
            subtitle: runtime?.sessionRows.find((row) => row.id === session.id)?.subtitle,
            alertLabel: runtime?.sessionRows.find((row) => row.id === session.id)?.alertLabel,
          });
        }

        // Ad-hoc sessions
        for (const session of adHocSessions) {
          items.push({
            type: 'session',
            session,
            workspaceId: ws.id,
            subtitle: runtime?.sessionRows.find((row) => row.id === session.id)?.subtitle,
            alertLabel: runtime?.sessionRows.find((row) => row.id === session.id)?.alertLabel,
          });
        }

        const workspaceReplays = replays
          .filter((replay) => replay.workspaceId === ws.id)
          .sort((a, b) => b.startedAt - a.startedAt);

        if (workspaceReplays.length > 0) {
          const replaySectionExpanded = expandedReplaySections.has(ws.id);
          items.push({
            type: 'replay-section',
            workspaceId: ws.id,
            count: workspaceReplays.length,
            expanded: replaySectionExpanded,
          });

          if (replaySectionExpanded) {
            for (const replay of workspaceReplays) {
              items.push({
                type: 'replay',
                replay,
                workspaceId: ws.id,
              });
            }
          }
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

        // Manage bundle config action
        items.push({
          type: 'bundle-config',
          workspaceId: ws.id,
        });

        const agentExpanded = expandedAgentSections.has(ws.id);
        items.push({
          type: 'agents',
          workspaceId: ws.id,
          count: agentSessionCounts[ws.id] ?? 0,
          pendingPermissions: pendingPermissionsByWorkspace[ws.id] ?? 0,
          expanded: agentExpanded,
        });

        if (agentExpanded) {
          items.push({
            type: 'new-agent-session',
            workspaceId: ws.id,
          });
          const agentSessions = [...(agentSessionsByWorkspace[ws.id] ?? [])].sort((a, b) =>
            (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
          );
          for (const session of agentSessions) {
            items.push({
              type: 'agent-session',
              session,
              workspaceId: ws.id,
            });
          }
        }

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

    if (orphanedProjectReplays.length > 0) {
      const orphanKey = `orphan:${group.name}`;
      const orphanExpanded = expandedReplaySections.has(orphanKey);
      items.push({
        type: 'orphaned-replay-section',
        projectName: group.name,
        count: orphanedProjectReplays.length,
        expanded: orphanExpanded,
      });

      if (orphanExpanded) {
        for (const replay of orphanedProjectReplays) {
          items.push({
            type: 'replay',
            replay,
            workspaceId: replay.workspaceId ?? orphanKey,
          });
        }
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
    replays,
    onAttachSession,
    onOpenReplay,
    onStartProcessAttach,
    onStopProcess,
    onProcessDisabled,
    onOpenEvents,
    onOpenAgents,
    onOpenAgentSession,
    onCreateAgentSession,
    agentSessionCounts = {},
    agentSessionsByWorkspace = {},
    pendingPermissionsByWorkspace = {},
    runtimeByWorkspace = {},
    onEditProcesses,
    onManageBundleConfig,
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
  const [expandedAgentSections, setExpandedAgentSections] = useState<Set<string>>(new Set());
  const [expandedReplaySections, setExpandedReplaySections] = useState<Set<string>>(new Set());

  // Build tree
  const tree = useMemo(
    () => buildTree(workspaces, sessions, replays, expandedWorkspaces, expandedAgentSections, expandedReplaySections, agentSessionCounts, showProjectHeaders, agentSessionsByWorkspace, pendingPermissionsByWorkspace, runtimeByWorkspace),
    [workspaces, sessions, replays, expandedWorkspaces, expandedAgentSections, expandedReplaySections, agentSessionCounts, showProjectHeaders, agentSessionsByWorkspace, pendingPermissionsByWorkspace, runtimeByWorkspace]
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
      sessions
        .filter(
          (session) =>
            session.workspaceId === workspaceId &&
            session.processName === processName &&
            (session.processInstance ?? 1) === instance &&
            session.exitCode === undefined
        )
        .sort((a, b) => b.createdAt - a.createdAt)[0],
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
    let expanded = false;
    setExpandedWorkspaces(prev => {
      const next = new Set(prev);
      if (next.has(workspaceId)) {
        next.delete(workspaceId);
      } else {
        next.add(workspaceId);
        expanded = true;
      }
      return next;
    });
    if (expanded) {
      void (onRefreshSessions?.() ?? onRefresh());
    }
  }, [onRefresh, onRefreshSessions]);

  const toggleReplaySection = useCallback((workspaceId: string) => {
    setExpandedReplaySections(prev => {
      const next = new Set(prev);
      if (next.has(workspaceId)) {
        next.delete(workspaceId);
      } else {
        next.add(workspaceId);
      }
      return next;
    });
  }, []);

  const toggleAgentSection = useCallback((workspaceId: string) => {
    let expanded = false;
    setExpandedAgentSections((prev) => {
      const next = new Set(prev);
      if (next.has(workspaceId)) {
        next.delete(workspaceId);
      } else {
        next.add(workspaceId);
        expanded = true;
      }
      return next;
    });
    if (expanded) {
      void onOpenAgents?.(workspaceId);
    }
  }, [onOpenAgents]);

  const activateItem = useCallback(async (item: TreeItem | null) => {
    if (!item) return;

    if (item.type === 'workspace') {
      toggleWorkspace(item.workspace.id);
    } else if (item.type === 'orphaned-replay-section') {
      toggleReplaySection(`orphan:${item.projectName}`);
    } else if (item.type === 'replay-section') {
      toggleReplaySection(item.workspaceId);
    } else if (item.type === 'session') {
      await onAttachSession({
        sessionId: item.session.id,
        viewOnly: item.session.processName ? true : undefined,
      });
    } else if (item.type === 'replay') {
      await onOpenReplay(item.replay.replayId);
    } else if (item.type === 'process') {
      if (item.status === 'running') {
        const session = item.attachableSessionId
          ? sessions.find((candidate) => candidate.id === item.attachableSessionId)
          : findSessionForProcess(
              item.workspaceId,
              item.processName,
              item.instance,
            );
        if (session) {
          await onAttachSession({ sessionId: session.id, viewOnly: true });
        } else {
          onStartProcessAttach({
            workspaceId: item.workspaceId,
            processName: item.processName,
            instance: item.instance,
          });
        }
      } else {
        onStartProcessAttach({
          workspaceId: item.workspaceId,
          processName: item.processName,
          instance: item.instance,
        });
      }
    } else if (item.type === 'process-disabled') {
      onProcessDisabled?.({
        workspaceId: item.workspaceId,
        processName: item.processName,
      });
    } else if (item.type === 'process-config-error') {
      onEditProcesses?.({ workspaceId: item.workspaceId });
    } else if (item.type === 'edit-processes') {
      onEditProcesses?.({ workspaceId: item.workspaceId });
    } else if (item.type === 'bundle-config') {
      onManageBundleConfig?.({ workspaceId: item.workspaceId });
    } else if (item.type === 'agents') {
      toggleAgentSection(item.workspaceId);
    } else if (item.type === 'agent-session') {
      await onOpenAgentSession?.(item.workspaceId, item.session.id);
    } else if (item.type === 'new-agent-session') {
      await onCreateAgentSession?.(item.workspaceId);
    } else if (item.type === 'events') {
      onOpenEvents(item.workspaceId);
    } else if (item.type === 'new-session') {
      await onAttachSession({ workspaceId: item.workspaceId });
    }
  }, [toggleWorkspace, toggleAgentSection, toggleReplaySection, onAttachSession, onOpenReplay, onStartProcessAttach, findSessionForProcess, onProcessDisabled, onEditProcesses, onManageBundleConfig, onOpenAgentSession, onCreateAgentSession, onOpenEvents]);

  const activateSelected = useCallback(async () => {
    await activateItem(selectedItem);
  }, [activateItem, selectedItem]);

  const activateIndex = useCallback(async (index: number) => {
    const clamped = Math.max(0, Math.min(index, tree.length - 1));
    setSelectedIndex(clamped);
    await activateItem(tree[clamped] ?? null);
  }, [activateItem, tree]);

  const createNewSession = useCallback(async () => {
    if (!selectedItem) return;

    let workspaceId: string | null = null;
    if (selectedItem.type === 'workspace') {
      workspaceId = selectedItem.workspace.id;
    } else if ('workspaceId' in selectedItem) {
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
    expandedAgentSections,
    machineName: machineName ?? null,

    // Computed flags
    isEmpty,

    // Actions
    moveUp,
    moveDown,
    selectIndex,
    toggleWorkspace,
    toggleAgentSection,
    activateSelected,
    activateIndex,
    attachSession: async (params) => {
      await onAttachSession(params);
    },
    openReplay: async (replayId) => {
      await onOpenReplay(replayId);
    },
    startProcessAttach: (params) => onStartProcessAttach(params),
    stopProcess: (params) => onStopProcess?.(params),
    createNewSession,
    createWorkspace,
    refresh,
    openEvents: (workspaceId) => onOpenEvents(workspaceId),
    editProcesses: (params) => onEditProcesses?.(params),
    manageBundleConfig: (params) => onManageBundleConfig?.(params),
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
