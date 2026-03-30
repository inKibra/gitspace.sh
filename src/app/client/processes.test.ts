import { describe, expect, it, mock } from 'bun:test';
import type { BackendScopedWorkspaceRef } from '../../machine/multi/types.js';
import type { SessionBackend } from '../../session/backend.js';
import { createAppProcessesClient } from './processes.js';
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

function makeContext(workspaceRefs: BackendScopedWorkspaceRef[], backendByKey: Record<string, SessionBackend | null>): AppClientContext {
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
  };
  return { multi, workspaceRefs };
}

describe('app client processes', () => {
  it('starts a process on the resolved backend', async () => {
    const startProcess = mock(async () => undefined);
    const backend = makeBackend({ startProcess });
    const workspaceRef = { backendKey: 'local', workspaceId: 'proj:ws-1' } satisfies BackendScopedWorkspaceRef;

    const client = createAppProcessesClient(makeContext([workspaceRef], { local: backend }));
    const result = await client.start('proj:ws-1', 'web', 2);

    expect(result.ok).toBe(true);
    expect(startProcess).toHaveBeenCalledWith('proj:ws-1', 'web', 2);
  });

  it('stops a process on the resolved backend', async () => {
    const stopProcess = mock(async () => undefined);
    const backend = makeBackend({ stopProcess });
    const workspaceRef = { backendKey: 'local', workspaceId: 'proj:ws-1' } satisfies BackendScopedWorkspaceRef;

    const client = createAppProcessesClient(makeContext([workspaceRef], { local: backend }));
    const result = await client.stop('proj:ws-1', 'web');

    expect(result.ok).toBe(true);
    expect(stopProcess).toHaveBeenCalledWith('proj:ws-1', 'web');
  });
});
