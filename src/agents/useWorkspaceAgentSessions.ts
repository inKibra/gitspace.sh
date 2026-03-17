import { useCallback, useMemo, useState } from 'react';
import type { SessionBackend } from '../session/backend.js';
import type { SessionStatus } from './opencode-event-types.js';

export interface AgentSessionInfo {
  id: string;
  workspaceId: string;
  title: string;
  updatedAt?: string;
  closed?: boolean;
  status?: SessionStatus;
  pendingPermissionCount?: number;
  errorMessage?: string;
}

export interface UseWorkspaceAgentSessionsOptions {
  backend?: SessionBackend | null;
}

function mapSessions(
  workspaceId: string,
  sessions: Array<{ id: string; title: string; updatedAt?: string; closed?: boolean }>,
  statusMap: Record<string, SessionStatus>,
  pendingPermissionMap: Record<string, unknown[]>,
): AgentSessionInfo[] {
  return sessions.map((session) => ({
    id: session.id,
    workspaceId,
    title: session.title,
    updatedAt: session.updatedAt,
    closed: session.closed,
    status: statusMap[session.id],
    pendingPermissionCount: pendingPermissionMap[session.id]?.length ?? 0,
  }));
}

function mergeSessions(existing: AgentSessionInfo[], next: AgentSessionInfo[]): AgentSessionInfo[] {
  const combined = new Map<string, AgentSessionInfo>();
  for (const session of existing) {
    combined.set(session.id, session);
  }
  for (const session of next) {
    combined.set(session.id, {
      ...(combined.get(session.id) ?? {}),
      ...session,
    });
  }
  return Array.from(combined.values()).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

export function useWorkspaceAgentSessions(options: UseWorkspaceAgentSessionsOptions) {
  const [sessionsByWorkspace, setSessionsByWorkspace] = useState<Record<string, AgentSessionInfo[]>>({});
  const [loadingWorkspaceId, setLoadingWorkspaceId] = useState<string | null>(null);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const requireAgentMethod = useCallback(<T extends keyof SessionBackend>(name: T): NonNullable<SessionBackend[T]> => {
    const method = options.backend?.[name];
    if (!method) {
      throw new Error('Agent backend unavailable');
    }
    if (typeof method === 'function') {
      return method.bind(options.backend) as NonNullable<SessionBackend[T]>;
    }
    return method as NonNullable<SessionBackend[T]>;
  }, [options.backend]);

  const getStatusMap = useCallback((workspaceId: string) => {
    const snapshot = options.backend?.getAgentStateSnapshot() ?? {};
    return snapshot[workspaceId]?.statuses ?? {};
  }, [options.backend]);

  const getPendingPermissionMap = useCallback((workspaceId: string) => {
    const snapshot = options.backend?.getAgentStateSnapshot() ?? {};
    return snapshot[workspaceId]?.pendingPermissions ?? {};
  }, [options.backend]);

  const getSnapshotSessions = useCallback((workspaceId: string) => {
    const snapshot = options.backend?.getAgentStateSnapshot() ?? {};
    return snapshot[workspaceId]?.sessions ?? [];
  }, [options.backend]);

  const loadWorkspaceSessions = useCallback(async (
    workspaceId: string,
    options: { updateSelection?: boolean } = {},
  ) => {
    const getKnownAgentSessions = requireAgentMethod('getKnownAgentSessions');
    const listAgentSessions = requireAgentMethod('listAgentSessions');
    const shouldUpdateSelection = options.updateSelection !== false;
    if (shouldUpdateSelection) {
      setLoadingWorkspaceId(workspaceId);
      setActiveWorkspaceId(workspaceId);
    }
    setError(null);

    try {
      const known = await getKnownAgentSessions(workspaceId);
      const snapshotMapped = mapSessions(workspaceId, getSnapshotSessions(workspaceId), getStatusMap(workspaceId), getPendingPermissionMap(workspaceId));
      const knownMapped = mergeSessions(
        snapshotMapped,
        mapSessions(workspaceId, known, getStatusMap(workspaceId), getPendingPermissionMap(workspaceId)),
      );

      if (knownMapped.length > 0) {
        setSessionsByWorkspace((current) => ({ ...current, [workspaceId]: knownMapped }));
        void listAgentSessions(workspaceId)
          .then((live) => {
            const liveMapped = mapSessions(workspaceId, live, getStatusMap(workspaceId), getPendingPermissionMap(workspaceId));
            setSessionsByWorkspace((current) => ({
              ...current,
              [workspaceId]: liveMapped.length > 0
                ? mergeSessions(current[workspaceId] ?? [], liveMapped)
                : (current[workspaceId] ?? knownMapped),
            }));
          })
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => {
            if (shouldUpdateSelection) {
              setLoadingWorkspaceId((current) => (current === workspaceId ? null : current));
            }
          });
        return knownMapped;
      }

      const live = await listAgentSessions(workspaceId);
      const mapped = mergeSessions(
        snapshotMapped,
        mapSessions(workspaceId, live, getStatusMap(workspaceId), getPendingPermissionMap(workspaceId)),
      );
      setSessionsByWorkspace((current) => ({ ...current, [workspaceId]: mapped }));
      return mapped;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      throw err;
    } finally {
      if (shouldUpdateSelection) {
        setLoadingWorkspaceId((current) => (current === workspaceId ? null : current));
      }
    }
  }, [getPendingPermissionMap, getSnapshotSessions, getStatusMap, requireAgentMethod]);

  const createSession = useCallback(async (workspaceId: string, title?: string) => {
    const createAgentSession = requireAgentMethod('createAgentSession');
    const sessions = await createAgentSession(workspaceId, title);
    const mapped = mapSessions(workspaceId, sessions, getStatusMap(workspaceId), getPendingPermissionMap(workspaceId));
    setSessionsByWorkspace((current) => ({ ...current, [workspaceId]: mapped }));
    return mapped;
  }, [getPendingPermissionMap, getStatusMap, requireAgentMethod]);

  const abortSession = useCallback(async (workspaceId: string, sessionId: string) => {
    const abortAgentSession = requireAgentMethod('abortAgentSession');
    await abortAgentSession(workspaceId, sessionId);
    return loadWorkspaceSessions(workspaceId);
  }, [loadWorkspaceSessions, requireAgentMethod]);

  const clearSession = useCallback(async (workspaceId: string, sessionId: string) => {
    const clearAgentSession = requireAgentMethod('clearAgentSession');
    await clearAgentSession(workspaceId, sessionId);
    let nextSessions: AgentSessionInfo[] = [];
    setSessionsByWorkspace((current) => ({
      ...current,
      [workspaceId]: (() => {
        nextSessions = (current[workspaceId] ?? []).filter((session) => session.id !== sessionId);
        return nextSessions;
      })(),
    }));
    return nextSessions;
  }, [requireAgentMethod]);

  const syncWorkspaceSessions = useCallback(async (workspaceIds: string[]) => {
    const uniqueWorkspaceIds = Array.from(new Set(workspaceIds.filter(Boolean)));
    const results = await Promise.allSettled(
      uniqueWorkspaceIds.map((workspaceId) => loadWorkspaceSessions(workspaceId, { updateSelection: false })),
    );
    const rejection = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejection) {
      throw rejection.reason;
    }
  }, [loadWorkspaceSessions]);

  const sessions = useMemo(() => {
    if (!activeWorkspaceId) {
      return [];
    }
    return sessionsByWorkspace[activeWorkspaceId] ?? [];
  }, [activeWorkspaceId, sessionsByWorkspace]);

  return {
    activeWorkspaceId,
    sessionsByWorkspace,
    sessions,
    loadingWorkspaceId,
    error,
    setActiveWorkspaceId,
    loadWorkspaceSessions,
    syncWorkspaceSessions,
    createSession,
    abortSession,
    clearSession,
  };
}
