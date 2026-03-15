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

  const loadWorkspaceSessions = useCallback(async (workspaceId: string, workspaceName?: string) => {
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

      // Filter to only sessions belonging to this workspace (by title prefix)
      // and strip the prefix for display
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      throw err;
    } finally {
      setLoadingWorkspaceId((current) => (current === workspaceId ? null : current));
    }
  }, [createClient, options.backend]);

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
