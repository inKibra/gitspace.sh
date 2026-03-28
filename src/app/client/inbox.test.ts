import { describe, expect, it, mock } from 'bun:test';
import type { BackendScopedWorkspaceRef } from '../../machine/multi/types.js';
import type { SessionBackend } from '../../session/backend.js';
import { createAppInboxClient } from './inbox.js';
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
    killSession: async () => undefined,
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

function makeContext(workspaceRefs: BackendScopedWorkspaceRef[], backendByKey: Record<string, SessionBackend | null>, multiOverrides: Partial<AppClientMulti> = {}): AppClientContext {
  const multi: AppClientMulti = {
    getBackend: (backendKey) => backendByKey[backendKey] ?? null,
    createAgentSession: async () => [],
    abortAgentSession: async () => false,
    closeAgentSession: async () => [],
    archiveAgentSession: async () => [],
    restoreAgentSession: async () => [],
    attachAgentSession: async () => undefined,
    getAgentSessionPreference: async () => null,
    setAgentSessionPreference: async () => undefined,
    requestInbox: async () => undefined,
    clearInbox: async () => undefined,
    markInboxRead: async () => undefined,
    ...multiOverrides,
  };
  return { multi, workspaceRefs };
}

describe('app client inbox', () => {
  it('marks inbox items read through the multi client', async () => {
    const markInboxRead = mock(async () => undefined);
    const client = createAppInboxClient(makeContext([], {}, { markInboxRead }));
    const result = await client.markRead('item-1');
    expect(result.ok).toBe(true);
    expect(markInboxRead).toHaveBeenCalledWith('item-1');
  });

  it('responds to permission requests through resolved backend refs', async () => {
    const respondToAgentPermission = mock(async () => true);
    const backend = makeBackend({});
    const workspaceRef = { backendKey: 'local', workspaceId: 'proj:ws-1' } satisfies BackendScopedWorkspaceRef;
    const client = createAppInboxClient(makeContext([workspaceRef], { local: backend }, { respondToAgentPermission }));
    const result = await client.respondToPermission('proj:ws-1', 'agent-1', 'perm-1', 'allow');
    expect(result.ok).toBe(true);
    expect(respondToAgentPermission).toHaveBeenCalledWith({ backendKey: 'local', workspaceId: 'proj:ws-1', agentSessionId: 'agent-1' }, 'perm-1', 'allow');
  });
});
