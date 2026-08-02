import { describe, expect, it, mock } from 'bun:test';
import type { SessionBackend } from '../../session/backend.js';
import { createAppSessionsClient } from './sessions.js';
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

function makeContext(backend: SessionBackend): AppClientContext {
  const multi: AppClientMulti = {
    getBackend: () => backend,
    createAgentSession: async () => [],
    killAgentSession: async () => false,
    stopAgentTurn: async () => false,
    closeAgentSession: async () => [],
    archiveAgentSession: async () => [],
    restoreAgentSession: async () => [],
    openAgentSession: async () => undefined,
    getAgentSessionPreference: async () => null,
    setAgentSessionPreference: async () => undefined,
  };
  return { multi, workspaceRefs: [] };
}

describe('app client sessions', () => {
  it('attaches session through backend', async () => {
    const attachSession = mock(async () => undefined);
    const client = createAppSessionsClient(makeContext(makeBackend({ attachSession })));
    const result = await client.attach({ backendKey: 'local', workspaceId: 'proj:ws-1' }, { workspaceId: 'proj:ws-1' });
    expect(result.ok).toBe(true);
    expect(attachSession).toHaveBeenCalledWith({ workspaceId: 'proj:ws-1' });
  });

  it('cancels pending scripts through backend', async () => {
    const cancelPendingScripts = mock(async () => undefined);
    const client = createAppSessionsClient(makeContext(makeBackend({ cancelPendingScripts })));
    const result = await client.cancelPendingScripts({ backendKey: 'local', workspaceId: 'proj:ws-1' });
    expect(result.ok).toBe(true);
    expect(cancelPendingScripts).toHaveBeenCalledTimes(1);
  });
});
