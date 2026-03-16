import { defaultOpenCodeCoordinator, type AgentSessionSummary, type AgentWorkspaceTarget } from '../../agents/opencode-coordinator.js';
import { defaultOpenCodeRuntimeManager } from '../../agents/opencode-runtime.js';
import { defaultAgentEventManager, type AgentStateUpdateDelta, type WorkspaceAgentState } from '../../serve/agent-event-manager.js';

let initializePromise: Promise<void> | null = null;

export function ensureAgentControlInitialized(): Promise<void> {
  if (!initializePromise) {
    initializePromise = (async () => {
      await defaultOpenCodeRuntimeManager.initialize();
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

export async function getKnownAgentSessions(target: AgentWorkspaceTarget): Promise<AgentSessionSummary[]> {
  await ensureAgentControlInitialized();
  return defaultOpenCodeCoordinator.getKnownAgentSessions(target.workspaceId);
}

export async function listLiveAgentSessions(target: AgentWorkspaceTarget): Promise<AgentSessionSummary[]> {
  await ensureAgentControlInitialized();
  return defaultOpenCodeCoordinator.refreshAgentSessions(target);
}

export async function createAgentSession(target: AgentWorkspaceTarget, title?: string): Promise<AgentSessionSummary[]> {
  await ensureAgentControlInitialized();
  return defaultOpenCodeCoordinator.createAgentSession(target, title);
}

export async function abortAgentSession(target: AgentWorkspaceTarget, agentSessionId: string): Promise<boolean> {
  await ensureAgentControlInitialized();
  return defaultOpenCodeCoordinator.abortAgentSession(target, agentSessionId);
}

export async function attachAgentSession(target: AgentWorkspaceTarget, agentSessionId: string): Promise<import('./protocol.js').Session> {
  await ensureAgentControlInitialized();
  return defaultOpenCodeCoordinator.ensureAgentTerminalSession(target, agentSessionId);
}

export async function respondToAgentPermission(
  target: AgentWorkspaceTarget,
  agentSessionId: string,
  permissionId: string,
  response: 'allow' | 'deny',
): Promise<boolean> {
  await ensureAgentControlInitialized();
  const runtime = await defaultOpenCodeRuntimeManager.getWorkspaceRuntime(target.workspaceId);
  if (!runtime) {
    return false;
  }

  const { OpenCodeClient } = await import('../../agents/opencode-client.js');
  const { createOpenCodeBasicAuthHeader } = await import('../../agents/opencode-runtime.js');
  const client = new OpenCodeClient({
    baseUrl: runtime.baseUrl,
    fetch: (input, init) =>
      fetch(input as RequestInfo, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          authorization: createOpenCodeBasicAuthHeader(runtime),
        },
      }),
  });
  return client.respondToPermission(agentSessionId, permissionId, response);
}
