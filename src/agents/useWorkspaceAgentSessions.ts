import { useCallback, useMemo, useState } from 'react';
import { OpenCodeRelayClient } from './opencode-relay-client.js';
import type { OpenCodeBridgeBackend, SessionBackend } from '../session/backend.js';
import type { SessionStatus } from './opencode-event-types.js';

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

  const loadWorkspaceSessions = useCallback(async (workspaceId: string) => {
    setLoadingWorkspaceId(workspaceId);
    setActiveWorkspaceId(workspaceId);
    setError(null);
    try {
      const client = createClient(workspaceId);
      const raw = await client.listSessions() as Array<Record<string, unknown>>;

      // Merge status from AgentEventManager snapshot if available
      const agentSnapshot = options.backend?.getAgentStateSnapshot() ?? {};
      const workspaceAgentState = agentSnapshot[workspaceId];
      const statusMap = workspaceAgentState?.statuses ?? {};

      const mapped: AgentSessionInfo[] = raw.map((session) => ({
        id: String(session.id),
        workspaceId,
        title: normalizeTitle(session.title, String(session.id)),
        updatedAt: typeof session.updatedAt === 'string' ? session.updatedAt : undefined,
        status: statusMap[String(session.id)],
      }));

      setSessionsByWorkspace((current) => ({
        ...current,
        [workspaceId]: mapped,
      }));
      return mapped;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      throw err;
    } finally {
      setLoadingWorkspaceId((current) => (current === workspaceId ? null : current));
    }
  }, [createClient, options.backend]);

  const createSession = useCallback(async (workspaceId: string, title?: string) => {
    const client = createClient(workspaceId);
    await client.createSession(title);
    return loadWorkspaceSessions(workspaceId);
  }, [createClient, loadWorkspaceSessions]);

  const abortSession = useCallback(async (workspaceId: string, sessionId: string) => {
    const client = createClient(workspaceId);
    await client.abortSession(sessionId);
    // Refresh list after abort
    return loadWorkspaceSessions(workspaceId);
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
