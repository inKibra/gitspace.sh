import { describe, expect, it, mock } from 'bun:test';
import type { BackendScopedWorkspaceRef } from '../../machine/multi/types.js';
import type { SessionBackend } from '../../session/backend.js';
import { createAppWorkspaceLifecycleClient } from './workspace-lifecycle.js';
import type { AppClientContext, AppClientMulti } from './context.js';

function makeBackend(overrides: Partial<SessionBackend>): SessionBackend {
  return {
    descriptor: { key: 'local', kind: 'local', label: 'Local' },
    getAgentSessionPreference: async () => null,
    setAgentSessionPreference: async () => undefined,
    subscribeAgentState: () => () => undefined,
    getAgentStateSnapshot: () => ({}),
    respondToAgentPermission: async () => false,
    onEvent: () => () => undefined,
    connect: async () => undefined,
    disconnect: async () => undefined,
    listProjects: async () => undefined,
    listGithubRepos: async () => [],
    listRemoteBranches: async () => [],
    listLinearIssues: async () => [],
    listWorkspaces: async () => undefined,
    listSessions: async () => undefined,
    createProject: async () => undefined,
    createWorkspace: async () => undefined,
    deleteProject: async () => undefined,
    attachSession: async () => undefined,
    detachSession: async () => undefined,
    terminateSession: async () => undefined,
    deleteWorkspace: async () => undefined,
    getBundleRefreshPlan: async () => { throw new Error('unused'); },
    applyBundleRefresh: async () => undefined,
    getBundleConfigState: async () => { throw new Error('unused'); },
    applyBundleConfigUpdate: async () => undefined,
    requestInbox: async () => undefined,
    clearInbox: async () => undefined,
    markInboxRead: async () => undefined,
    getNotificationConfig: async () => undefined,
    updateNotificationConfig: async () => undefined,
    sendReviewRequest: async () => { throw new Error('unused'); },
    ...overrides,
  } as SessionBackend;
}

function makeContext(backendByKey: Record<string, SessionBackend | null>, multiOverrides: Partial<AppClientMulti> = {}): AppClientContext {
  const multi: AppClientMulti = {
    getBackend: (backendKey) => backendByKey[backendKey] ?? null,
    createAgentSession: async () => [],
    killAgentSession: async () => false,
    stopAgentTurn: async () => false,
    closeAgentSession: async () => [],
    archiveAgentSession: async () => [],
    restoreAgentSession: async () => [],
    attachAgentSession: async () => undefined,
    getAgentSessionPreference: async () => null,
    setAgentSessionPreference: async () => undefined,
    listWorkspaces: async () => undefined,
    listSessions: async () => undefined,
    listReplays: async () => undefined,
    ...multiOverrides,
  };
  return { multi, workspaceRefs: [] };
}

describe('app client workspace lifecycle', () => {
  it('sets workspace status through the resolved backend', async () => {
    const setWorkspaceStatus = mock(async () => undefined);
    const previewWorkspaceStatusChange = mock(async () => ({ allowed: true, requiresCascade: false, requestedPhase: 'review' as const, affected: [], message: 'ok' }));
    const backend = makeBackend({ previewWorkspaceStatusChange, setWorkspaceStatus });
    const workspaceRef = { backendKey: 'local', workspaceId: 'proj:ws-1' } satisfies BackendScopedWorkspaceRef;

    const client = createAppWorkspaceLifecycleClient(makeContext({ local: backend }));
    const preview = await client.previewStatus(workspaceRef, 'review');
    expect(preview.ok).toBe(true);
    const result = await client.setStatus(workspaceRef, 'review');
    expect(result.ok).toBe(true);
    expect(previewWorkspaceStatusChange).toHaveBeenCalledWith('proj', 'ws-1', 'review');
    expect(setWorkspaceStatus).toHaveBeenCalledWith('proj', 'ws-1', 'review', undefined);
  });

  it('deletes a workspace and refreshes list state', async () => {
    const deleteWorkspace = mock(async () => undefined);
    const listWorkspaces = mock(async () => undefined);
    const listSessions = mock(async () => undefined);
    const listReplays = mock(async () => undefined);
    const backend = makeBackend({ deleteWorkspace });
    const workspaceRef = { backendKey: 'local', workspaceId: 'proj:ws-1' } satisfies BackendScopedWorkspaceRef;

    const client = createAppWorkspaceLifecycleClient(makeContext(
      { local: backend },
      { listWorkspaces, listSessions, listReplays },
    ));
    const result = await client.deleteWorkspace(workspaceRef, { scriptPolicy: 'skip' });

    expect(result.ok).toBe(true);
    expect(deleteWorkspace).toHaveBeenCalledWith('proj', 'proj:ws-1', { scriptPolicy: 'skip', timeoutMs: 5 * 60 * 1000 });
    expect(listWorkspaces).toHaveBeenCalledTimes(1);
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(listReplays).toHaveBeenCalledWith(undefined, false);
  });
});
