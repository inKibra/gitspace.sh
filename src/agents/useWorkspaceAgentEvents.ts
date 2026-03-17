import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { SessionBackend } from '../session/backend.js';
import type { AgentStateUpdateDelta, WorkspaceAgentState } from '../serve/agent-event-manager.js';
import type { Permission, SessionStatus } from './opencode-event-types.js';

// ============================================================================
// Types
// ============================================================================

export interface AgentSessionLiveState {
  status: SessionStatus;
  pendingPermissions: Record<string, Permission>;  // permissionId → Permission
  lastMessagePreview: string;
  lastActivityAt: number;
  errorMessage?: string;
}

export type AgentNotificationType = 'permission_needed' | 'agent_idle' | 'agent_error';

export interface AgentNotification {
  type: AgentNotificationType;
  workspaceId: string;
  sessionId: string;
  sessionTitle: string;
  /** For permission_needed */
  permissionId?: string;
  permissionTitle?: string;
  /** For agent_idle */
  messagePreview?: string;
  /** For agent_error */
  errorMessage?: string;
  timestamp: number;
}

/** workspaceId → sessionId → live state */
export type WorkspaceAgentStateMap = Record<string, Record<string, AgentSessionLiveState>>;

export interface UseWorkspaceAgentEventsOptions {
  backend: SessionBackend | null;
  onNotification?: (notification: AgentNotification) => void;
}

export interface UseWorkspaceAgentEventsResult {
  /** All live agent session state, keyed by workspaceId then sessionId */
  workspaceStates: WorkspaceAgentStateMap;
  /** Total pending permission count across all workspaces */
  totalPendingPermissions: number;
  /** Pending permission count per workspace */
  pendingPermissionsByWorkspace: Record<string, number>;
  /** Respond to a permission request */
  respondToPermission(
    workspaceId: string,
    agentSessionId: string,
    permissionId: string,
    response: 'allow' | 'deny',
  ): Promise<void>;
}

// ============================================================================
// Helpers
// ============================================================================

function buildLiveStateFromWorkspace(workspace: WorkspaceAgentState): Record<string, AgentSessionLiveState> {
  const result: Record<string, AgentSessionLiveState> = {};
  const sessionIds = new Set<string>([
    ...workspace.sessions.map((session) => session.id),
    ...Object.keys(workspace.statuses),
    ...Object.keys(workspace.pendingPermissions),
    ...Object.keys(workspace.lastMessages),
  ]);
  for (const sessionId of sessionIds) {
    const status: SessionStatus = workspace.statuses[sessionId] ?? { type: 'idle' };
    const permissions = workspace.pendingPermissions[sessionId] ?? [];
    const pendingMap: Record<string, Permission> = {};
    for (const p of permissions) {
      pendingMap[p.id] = p;
    }
    result[sessionId] = {
      status,
      pendingPermissions: pendingMap,
      lastMessagePreview: workspace.lastMessages[sessionId] ?? '',
      lastActivityAt: Date.now(),
    };
  }
  return result;
}

function snapshotToWorkspaceStates(snapshot: Record<string, WorkspaceAgentState>): WorkspaceAgentStateMap {
  const result: WorkspaceAgentStateMap = {};
  for (const [workspaceId, workspace] of Object.entries(snapshot)) {
    result[workspaceId] = buildLiveStateFromWorkspace(workspace);
  }
  return result;
}

function countPendingPermissions(states: WorkspaceAgentStateMap): {
  total: number;
  byWorkspace: Record<string, number>;
} {
  let total = 0;
  const byWorkspace: Record<string, number> = {};
  for (const [workspaceId, sessions] of Object.entries(states)) {
    let count = 0;
    for (const session of Object.values(sessions)) {
      count += Object.keys(session.pendingPermissions).length;
    }
    byWorkspace[workspaceId] = count;
    total += count;
  }
  return { total, byWorkspace };
}

// ============================================================================
// Hook
// ============================================================================

export function useWorkspaceAgentEvents({
  backend,
  onNotification,
}: UseWorkspaceAgentEventsOptions): UseWorkspaceAgentEventsResult {
  const [workspaceStates, setWorkspaceStates] = useState<WorkspaceAgentStateMap>(() => {
    if (!backend) return {};
    return snapshotToWorkspaceStates(backend.getAgentStateSnapshot());
  });

  // Mutable refs for cross-delta tracking (not React state — never triggers re-renders)
  const prevStatusesRef = useRef<Record<string, SessionStatus>>({});
  const sessionTitlesRef = useRef<Record<string, string>>({});

  // Populate from snapshot on first render (refs are stable across renders)
  if (backend && Object.keys(prevStatusesRef.current).length === 0) {
    const snapshot = backend.getAgentStateSnapshot();
    for (const [wid, ws] of Object.entries(snapshot)) {
      for (const [sid, status] of Object.entries(ws.statuses)) {
        prevStatusesRef.current[`${wid}:${sid}`] = status;
      }
      for (const s of ws.sessions) {
        sessionTitlesRef.current[`${ws.workspaceId}:${s.id}`] = s.title;
      }
    }
  }

  // Keep onNotification in a ref so the effect always uses the latest callback
  const onNotificationRef = useRef(onNotification);
  onNotificationRef.current = onNotification;

  useEffect(() => {
    if (!backend) return;

    const snapshot = backend.getAgentStateSnapshot();
    setWorkspaceStates(snapshotToWorkspaceStates(snapshot));

    const unsubscribe = backend.subscribeAgentState((delta: AgentStateUpdateDelta) => {
      setWorkspaceStates((prev) => {
        const next = { ...prev };

        if (delta.type === 'agent_state_snapshot') {
          return snapshotToWorkspaceStates(delta.workspaces);
        }

        if (!('workspaceId' in delta)) return next;
        const { workspaceId } = delta;

        switch (delta.type) {
          case 'agent_session_status': {
            const { sessionId, status } = delta;
            const prevKey = `${workspaceId}:${sessionId}`;
            const prevStatus = prevStatusesRef.current[prevKey];
            prevStatusesRef.current[prevKey] = status;

            next[workspaceId] = {
              ...next[workspaceId],
              [sessionId]: {
                ...(next[workspaceId]?.[sessionId] ?? {
                  pendingPermissions: {},
                  lastMessagePreview: '',
                  lastActivityAt: Date.now(),
                }),
                status,
                lastActivityAt: Date.now(),
                errorMessage: undefined,
              },
            };

            if (prevStatus?.type === 'busy' && status.type === 'idle' && onNotificationRef.current) {
              const preview = next[workspaceId]?.[sessionId]?.lastMessagePreview ?? '';
              onNotificationRef.current({
                type: 'agent_idle',
                workspaceId,
                sessionId,
                sessionTitle: sessionTitlesRef.current[`${workspaceId}:${sessionId}`] ?? sessionId,
                messagePreview: preview,
                timestamp: Date.now(),
              });
            }
            break;
          }

          case 'agent_permission_added': {
            const { sessionId, permission } = delta;
            const existing = next[workspaceId]?.[sessionId];
            next[workspaceId] = {
              ...next[workspaceId],
              [sessionId]: {
                ...(existing ?? {
                  status: { type: 'idle' },
                  lastMessagePreview: '',
                  lastActivityAt: Date.now(),
                }),
                pendingPermissions: {
                  ...(existing?.pendingPermissions ?? {}),
                  [permission.id]: permission,
                },
                lastActivityAt: Date.now(),
                errorMessage: undefined,
              },
            };
            onNotificationRef.current?.({
              type: 'permission_needed',
              workspaceId,
              sessionId,
              sessionTitle: sessionTitlesRef.current[`${workspaceId}:${sessionId}`] ?? sessionId,
              permissionId: permission.id,
              permissionTitle: permission.title,
              timestamp: Date.now(),
            });
            break;
          }

          case 'agent_permission_removed': {
            const { sessionId, permissionId } = delta;
            const existing = next[workspaceId]?.[sessionId];
            if (existing?.pendingPermissions[permissionId]) {
              const { [permissionId]: _removed, ...rest } = existing.pendingPermissions;
              next[workspaceId] = {
                ...next[workspaceId],
                [sessionId]: { ...existing, pendingPermissions: rest, errorMessage: undefined },
              };
            }
            break;
          }

          case 'agent_session_error': {
            const { sessionId, errorMessage } = delta;
            const existing = next[workspaceId]?.[sessionId];
            next[workspaceId] = {
              ...next[workspaceId],
              [sessionId]: {
                ...(existing ?? {
                  status: { type: 'idle' },
                  pendingPermissions: {},
                  lastMessagePreview: '',
                  lastActivityAt: Date.now(),
                }),
                errorMessage,
                lastActivityAt: Date.now(),
              },
            };
            onNotificationRef.current?.({
              type: 'agent_error',
              workspaceId,
              sessionId,
              sessionTitle: sessionTitlesRef.current[`${workspaceId}:${sessionId}`] ?? sessionId,
              errorMessage,
              timestamp: Date.now(),
            });
            break;
          }

          case 'agent_last_message': {
            const { sessionId, preview } = delta;
            const existing = next[workspaceId]?.[sessionId];
            if (existing) {
              next[workspaceId] = {
                ...next[workspaceId],
                [sessionId]: { ...existing, lastMessagePreview: preview, errorMessage: undefined },
              };
            }
            break;
          }

          case 'agent_session_created': {
            const { sessionId, title } = delta;
            sessionTitlesRef.current[`${workspaceId}:${sessionId}`] = title;
            if (!next[workspaceId]?.[sessionId]) {
              next[workspaceId] = {
                ...next[workspaceId],
                [sessionId]: {
                  status: { type: 'idle' },
                  pendingPermissions: {},
                  lastMessagePreview: '',
                  lastActivityAt: Date.now(),
                  errorMessage: undefined,
                },
              };
            }
            break;
          }

          case 'agent_session_updated': {
            const { sessionId, title } = delta;
            sessionTitlesRef.current[`${workspaceId}:${sessionId}`] = title;
            const existing = next[workspaceId]?.[sessionId];
            if (existing) {
              next[workspaceId] = {
                ...next[workspaceId],
                [sessionId]: { ...existing, errorMessage: undefined },
              };
            }
            break;
          }

          case 'agent_session_deleted': {
            const { sessionId } = delta;
            if (next[workspaceId]) {
              const { [sessionId]: _removed, ...rest } = next[workspaceId];
              next[workspaceId] = rest;
              delete prevStatusesRef.current[`${workspaceId}:${sessionId}`];
              delete sessionTitlesRef.current[`${workspaceId}:${sessionId}`];
            }
            break;
          }
        }

        return next;
      });
    });

    return unsubscribe;
  }, [backend]);

  const respondToPermission = useCallback(async (
    workspaceId: string,
    agentSessionId: string,
    permissionId: string,
    response: 'allow' | 'deny',
  ) => {
    if (!backend) return;
    await backend.respondToAgentPermission(workspaceId, agentSessionId, permissionId, response);
  }, [backend]);

  const { total, byWorkspace } = useMemo(
    () => countPendingPermissions(workspaceStates),
    [workspaceStates],
  );

  return {
    workspaceStates,
    totalPendingPermissions: total,
    pendingPermissionsByWorkspace: byWorkspace,
    respondToPermission,
  };
}
