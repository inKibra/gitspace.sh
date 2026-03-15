import { useCallback, useMemo, useState } from 'react';
import { OpenCodeRelayClient } from './opencode-relay-client.js';
import type { OpenCodeBridgeBackend, SessionBackend } from '../session/backend.js';
import type { SessionStatus } from './opencode-event-types.js';

/** Workspace-scoped title prefix, e.g. "[my-feature] " */
function workspacePrefix(workspaceName: string): string {
  return `[${workspaceName}] `;
}

/** Strip the workspace prefix from a session title for display */
function stripPrefix(title: string, prefix: string): string {
  return title.startsWith(prefix) ? title.slice(prefix.length) : title;
}

export interface AgentSessionInfo {
  id: string;
  workspaceId: string;
  title: string;
  updatedAt?: string;
  /** Current status from AgentEventManager snapshot, if available */
  status?: SessionStatus;
}

export interface UseWorkspaceAgentSessionsOptions {
  bridge: Pick<OpenCodeBridgeBackend, 'requestOpenCode' | 'subscribeOpenCode'> | null;
  /** Full backend for status merging and abort */
  backend?: SessionBackend | null;
}

function normalizeTitle(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function mapKnownSessions(
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

  const createClient = useCallback((workspaceId: string) => {
    if (!options.bridge) {
      throw new Error('OpenCode bridge unavailable');
    }
    return new OpenCodeRelayClient({
      workspaceId,
      backend: options.bridge,
    });
  }, [options.bridge]);

  const getKnownWorkspaceSessions = useCallback(async (workspaceId: string): Promise<AgentSessionInfo[]> => {
    const agentSnapshot = options.backend?.getAgentStateSnapshot() ?? {};
    const workspaceAgentState = agentSnapshot[workspaceId];
    const statusMap = workspaceAgentState?.statuses ?? {};

    if (workspaceAgentState?.sessions?.length) {
      return mapKnownSessions(workspaceId, workspaceAgentState.sessions, statusMap);
    }

    const backendWithKnownSessions = options.backend as (SessionBackend & {
      getKnownAgentSessions?: (workspaceId: string) => Promise<Array<{ id: string; title: string; updatedAt?: string }>>;
    }) | null | undefined;

    if (backendWithKnownSessions?.getKnownAgentSessions) {
      const known = await backendWithKnownSessions.getKnownAgentSessions(workspaceId);
      return mapKnownSessions(workspaceId, known, statusMap);
    }

    return [];
  }, [options.backend]);

  const refreshWorkspaceSessions = useCallback(async (workspaceId: string, workspaceName?: string) => {
    const client = createClient(workspaceId);
    const raw = await client.listSessions() as Array<Record<string, unknown>>;

    const agentSnapshot = options.backend?.getAgentStateSnapshot() ?? {};
    const workspaceAgentState = agentSnapshot[workspaceId];
    const statusMap = workspaceAgentState?.statuses ?? {};
    const prefix = workspaceName ? workspacePrefix(workspaceName) : null;

    const mapped: AgentSessionInfo[] = raw
      .filter((session) => {
        if (!prefix) return true;
        const title = normalizeTitle(session.title, '');
        return title.startsWith(prefix);
      })
      .map((session) => {
        const rawTitle = normalizeTitle(session.title, String(session.id));
        return {
          id: String(session.id),
          workspaceId,
          title: prefix ? stripPrefix(rawTitle, prefix) : rawTitle,
          updatedAt: typeof session.updatedAt === 'string' ? session.updatedAt : undefined,
          status: statusMap[String(session.id)],
        };
      });

    setSessionsByWorkspace((current) => ({
      ...current,
      [workspaceId]: mapped,
    }));
    return mapped;
  }, [createClient, options.backend]);

  const loadWorkspaceSessions = useCallback(async (workspaceId: string, workspaceName?: string) => {
    setLoadingWorkspaceId(workspaceId);
    setActiveWorkspaceId(workspaceId);
    setError(null);
    try {
      const known = await getKnownWorkspaceSessions(workspaceId);
      if (known.length > 0) {
        setSessionsByWorkspace((current) => ({
          ...current,
          [workspaceId]: known,
        }));
        void refreshWorkspaceSessions(workspaceId, workspaceName)
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => setLoadingWorkspaceId((current) => (current === workspaceId ? null : current)));
        return known;
      }

      return await refreshWorkspaceSessions(workspaceId, workspaceName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      throw err;
    } finally {
      setLoadingWorkspaceId((current) => (current === workspaceId ? null : current));
    }
  }, [getKnownWorkspaceSessions, refreshWorkspaceSessions]);

  const createSession = useCallback(async (workspaceId: string, workspaceName: string, title?: string) => {
    const client = createClient(workspaceId);
    // Prefix the title with the workspace name so sessions are scoped per-workspace
    const prefixedTitle = `${workspacePrefix(workspaceName)}${title || 'New Session'}`;
    await client.createSession(prefixedTitle);
    return loadWorkspaceSessions(workspaceId, workspaceName);
  }, [createClient, loadWorkspaceSessions]);

  const abortSession = useCallback(async (workspaceId: string, sessionId: string, workspaceName?: string) => {
    const client = createClient(workspaceId);
    await client.abortSession(sessionId);
    // Refresh list after abort
    return loadWorkspaceSessions(workspaceId, workspaceName);
  }, [createClient, loadWorkspaceSessions]);

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
