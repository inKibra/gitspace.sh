import { defaultOpenCodeCoordinator, type AgentSessionSummary, type AgentWorkspaceTarget } from '../../agents/opencode-coordinator.js';
import { defaultOpenCodeRuntimeManager } from '../../agents/opencode-runtime.js';
import { defaultAgentEventManager, type AgentStateUpdateDelta, type WorkspaceAgentState } from './agent-event-manager.js';
import { getArchivedSessions } from '../../agents/agent-db.js';
import { scanWorkspaces } from '../remote-session/workspace-scanner.js';
import { toCanonicalWorkspaceId } from '../../utils/workspace-id.js';

let initializePromise: Promise<void> | null = null;

export async function syncKnownWorkspaces(): Promise<void> {
  const workspaces = await scanWorkspaces();
  for (const workspace of workspaces) {
    defaultAgentEventManager.registerWorkspace(
      toCanonicalWorkspaceId(workspace),
      workspace.path,
    );
  }
}

export function ensureAgentControlInitialized(): Promise<void> {
  if (!initializePromise) {
    initializePromise = (async () => {
      await defaultOpenCodeRuntimeManager.ensureMachineRuntime();
      await syncKnownWorkspaces();
      await defaultAgentEventManager.initialize();
    })().catch((error) => {
      initializePromise = null;
      throw error;
    });
  }
  return initializePromise;
}

export function subscribeAgentControl(handler: (delta: AgentStateUpdateDelta) => void): () => void {
  return defaultAgentEventManager.subscribe(handler);
}

export function getAgentControlSnapshot(): Record<string, WorkspaceAgentState> {
  return defaultAgentEventManager.getSnapshot();
}

/**
 * Returns sessions for a workspace from two sources:
 * 1. The AgentEventManager snapshot (non-archived, all starting as closed at startup).
 * 2. Archived sessions from the db (with archivedAt set).
 */
export async function getKnownAgentSessions(target: AgentWorkspaceTarget): Promise<AgentSessionSummary[]> {
  await ensureAgentControlInitialized();
  defaultAgentEventManager.registerWorkspace(target.workspaceId, target.workspacePath);

  const snapshot = defaultAgentEventManager.getSnapshot();
  const snapshotSessions: AgentSessionSummary[] = (snapshot[target.workspaceId]?.sessions ?? []).map((s) => ({
    id: s.id,
    workspaceId: target.workspaceId,
    title: s.title,
    updatedAt: s.updatedAt,
    closedAt: s.closedAt,
  }));

  const archived: AgentSessionSummary[] = getArchivedSessions(target.workspaceId).map((a) => ({
    id: a.sessionId,
    workspaceId: target.workspaceId,
    title: a.title,
    archivedAt: a.archivedAt,
  }));

  // Merge: snapshot wins over archived for the same id (snapshot has live/closed status).
  const merged = new Map<string, AgentSessionSummary>();
  for (const s of archived) merged.set(s.id, s);
  for (const s of snapshotSessions) merged.set(s.id, s);
  return Array.from(merged.values());
}

/**
 * Fetches live sessions from OpenCode and merges closedAt from the current
 * snapshot so sessions that haven't been un-closed by SSE stay closed.
 */
export async function listLiveAgentSessions(target: AgentWorkspaceTarget): Promise<AgentSessionSummary[]> {
  await ensureAgentControlInitialized();
  defaultAgentEventManager.registerWorkspace(target.workspaceId, target.workspacePath);

  const liveSessions = await defaultOpenCodeCoordinator.refreshAgentSessions(target);

  // Preserve closedAt from snapshot for sessions not yet activated by SSE.
  const snapshot = defaultAgentEventManager.getSnapshot();
  const snapshotMap = new Map(
    (snapshot[target.workspaceId]?.sessions ?? []).map((s) => [s.id, s]),
  );

  return liveSessions.map((s) => ({
    ...s,
    closedAt: snapshotMap.get(s.id)?.closedAt,
  }));
}

export async function createAgentSession(target: AgentWorkspaceTarget, title?: string): Promise<AgentSessionSummary[]> {
  await ensureAgentControlInitialized();
  defaultAgentEventManager.registerWorkspace(target.workspaceId, target.workspacePath);
  const sessions = await defaultOpenCodeCoordinator.createAgentSession(target, title);
  defaultAgentEventManager.syncKnownSessions(target.workspaceId, sessions);
  return sessions;
}

export async function abortAgentSession(target: AgentWorkspaceTarget, agentSessionId: string): Promise<boolean> {
  await ensureAgentControlInitialized();
  defaultAgentEventManager.registerWorkspace(target.workspaceId, target.workspacePath);
  return defaultOpenCodeCoordinator.abortAgentSession(target, agentSessionId);
}

export async function closeAgentSession(target: AgentWorkspaceTarget, agentSessionId: string): Promise<AgentSessionSummary[]> {
  await ensureAgentControlInitialized();
  defaultAgentEventManager.registerWorkspace(target.workspaceId, target.workspacePath);
  await defaultOpenCodeCoordinator.closeAgentSession(target, agentSessionId);
  defaultAgentEventManager.markSessionClosed(target.workspaceId, agentSessionId);
  return getKnownAgentSessions(target);
}

export async function archiveAgentSession(target: AgentWorkspaceTarget, agentSessionId: string): Promise<AgentSessionSummary[]> {
  await ensureAgentControlInitialized();
  defaultAgentEventManager.registerWorkspace(target.workspaceId, target.workspacePath);
  // Get the title from the snapshot before removing it.
  const snapshot = defaultAgentEventManager.getSnapshot();
  const sess = snapshot[target.workspaceId]?.sessions.find((s) => s.id === agentSessionId);
  const title = sess?.title ?? agentSessionId;
  await defaultOpenCodeCoordinator.archiveAgentSession(target, agentSessionId, title);
  defaultAgentEventManager.markSessionArchived(target.workspaceId, agentSessionId);
  return getKnownAgentSessions(target);
}

export async function restoreAgentSession(target: AgentWorkspaceTarget, agentSessionId: string): Promise<AgentSessionSummary[]> {
  await ensureAgentControlInitialized();
  defaultAgentEventManager.registerWorkspace(target.workspaceId, target.workspacePath);
  // Get title from archived db before deleting the row.
  const archived = getArchivedSessions(target.workspaceId).find((a) => a.sessionId === agentSessionId);
  const title = archived?.title ?? agentSessionId;
  await defaultOpenCodeCoordinator.restoreAgentSession(target, agentSessionId);
  defaultAgentEventManager.markSessionRestored(target.workspaceId, agentSessionId, title);
  return getKnownAgentSessions(target);
}

export async function attachAgentSession(target: AgentWorkspaceTarget, agentSessionId: string): Promise<import('./protocol.js').Session> {
  await ensureAgentControlInitialized();
  defaultAgentEventManager.registerWorkspace(target.workspaceId, target.workspacePath);
  defaultAgentEventManager.syncKnownSessions(
    target.workspaceId,
    await defaultOpenCodeCoordinator.refreshAgentSessions(target),
  );
  const session = await defaultOpenCodeCoordinator.ensureAgentTerminalSession(target, agentSessionId);
  defaultAgentEventManager.markSessionOpen(target.workspaceId, agentSessionId);
  void defaultAgentEventManager.reconcileWorkspace(target.workspaceId);
  return session;
}

export async function respondToAgentPermission(
  target: AgentWorkspaceTarget,
  _agentSessionId: string,
  permissionId: string,
  response: 'allow' | 'deny',
): Promise<boolean> {
  await ensureAgentControlInitialized();
  defaultAgentEventManager.registerWorkspace(target.workspaceId, target.workspacePath);
  const runtime = await defaultOpenCodeRuntimeManager.getWorkspaceRuntime(target.workspaceId);
  if (!runtime) return false;

  const { OpenCodeClient } = await import('../../agents/opencode-client.js');
  const { createOpenCodeBasicAuthHeader } = await import('../../agents/opencode-runtime.js');
  const client = new OpenCodeClient({
    baseUrl: runtime.baseUrl,
    directory: target.workspacePath,
    fetch: (input, init) =>
      fetch(input as RequestInfo, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          authorization: createOpenCodeBasicAuthHeader(runtime),
        },
      }),
  });
  return client.respondToPermission(permissionId, response);
}
