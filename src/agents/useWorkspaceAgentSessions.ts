import { useCallback, useMemo, useState } from 'react';
import type { SessionBackend } from '../session/backend.js';
import type { SessionStatus } from './opencode-event-types.js';

export interface AgentSessionInfo {
  id: string;
  workspaceId: string;
  title: string;
  updatedAt?: string;
  status?: SessionStatus;
}

export interface UseWorkspaceAgentSessionsOptions {
  backend?: SessionBackend | null;
}

function mapSessions(
  workspaceId: string,
  sessions: Array<{ id: string; title: string; updatedAt?: string }>,
  statusMap: Record<string, SessionStatus>,
): AgentSessionInfo[] {
  return sessions.map((session) => ({
    id: session.id,
    workspaceId,
    title: session.title,
    updatedAt: session.updatedAt,
    status: statusMap[session.id],
  }));
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
    return method as NonNullable<SessionBackend[T]>;
  }, [options.backend]);

  const getStatusMap = useCallback((workspaceId: string) => {
    const snapshot = options.backend?.getAgentStateSnapshot() ?? {};
    return snapshot[workspaceId]?.statuses ?? {};
  }, [options.backend]);

  const loadWorkspaceSessions = useCallback(async (workspaceId: string) => {
    const getKnownAgentSessions = requireAgentMethod('getKnownAgentSessions');
    const listAgentSessions = requireAgentMethod('listAgentSessions');
    setLoadingWorkspaceId(workspaceId);
    setActiveWorkspaceId(workspaceId);
    setError(null);

    try {
      const known = await getKnownAgentSessions(workspaceId);
      const knownMapped = mapSessions(workspaceId, known, getStatusMap(workspaceId));

      if (knownMapped.length > 0) {
        setSessionsByWorkspace((current) => ({ ...current, [workspaceId]: knownMapped }));
        void listAgentSessions(workspaceId)
          .then((live) => {
            setSessionsByWorkspace((current) => ({
              ...current,
              [workspaceId]: mapSessions(workspaceId, live, getStatusMap(workspaceId)),
            }));
          })
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => setLoadingWorkspaceId((current) => (current === workspaceId ? null : current)));
        return knownMapped;
      }

      const live = await listAgentSessions(workspaceId);
      const mapped = mapSessions(workspaceId, live, getStatusMap(workspaceId));
      setSessionsByWorkspace((current) => ({ ...current, [workspaceId]: mapped }));
      return mapped;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      throw err;
    } finally {
      setLoadingWorkspaceId((current) => (current === workspaceId ? null : current));
    }
  }, [getStatusMap, requireAgentMethod]);

  const createSession = useCallback(async (workspaceId: string, title?: string) => {
    const createAgentSession = requireAgentMethod('createAgentSession');
    const sessions = await createAgentSession(workspaceId, title);
    const mapped = mapSessions(workspaceId, sessions, getStatusMap(workspaceId));
    setSessionsByWorkspace((current) => ({ ...current, [workspaceId]: mapped }));
    return mapped;
  }, [getStatusMap, requireAgentMethod]);

  const abortSession = useCallback(async (workspaceId: string, sessionId: string) => {
    const abortAgentSession = requireAgentMethod('abortAgentSession');
    const listAgentSessions = requireAgentMethod('listAgentSessions');
    await abortAgentSession(workspaceId, sessionId);
    const sessions = await listAgentSessions(workspaceId);
    const mapped = mapSessions(workspaceId, sessions, getStatusMap(workspaceId));
    setSessionsByWorkspace((current) => ({ ...current, [workspaceId]: mapped }));
    return mapped;
  }, [getStatusMap, requireAgentMethod]);

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
    createSession,
    abortSession,
  };
}
