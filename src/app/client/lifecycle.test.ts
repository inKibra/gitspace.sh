import { describe, expect, it, mock } from 'bun:test';
import type { SessionBackend } from '../../session/backend.js';
import { createAppLifecycleClient } from './lifecycle.js';
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
    attachAgentSession: async () => undefined,
    getAgentSessionPreference: async () => null,
    setAgentSessionPreference: async () => undefined,
  };
  return { multi, workspaceRefs: [] };
}

describe('app client lifecycle', () => {
  it('creates project and refreshes backend lists', async () => {
    const createProject = mock(async () => undefined);
    const listProjects = mock(async () => undefined);
    const listWorkspaces = mock(async () => undefined);
    const listSessions = mock(async () => undefined);
    const client = createAppLifecycleClient(makeContext(makeBackend({ createProject, listProjects, listWorkspaces, listSessions })));
    const result = await client.createProject('local', { repository: 'acme/repo' });
    expect(result.ok).toBe(true);
    expect(createProject).toHaveBeenCalledTimes(1);
    expect(listProjects).toHaveBeenCalledTimes(1);
  });

  it('creates workspace and refreshes workspace/session lists', async () => {
    const createWorkspace = mock(async () => undefined);
    const listWorkspaces = mock(async () => undefined);
    const listSessions = mock(async () => undefined);
    const client = createAppLifecycleClient(makeContext(makeBackend({ createWorkspace, listWorkspaces, listSessions })));
    const result = await client.createWorkspace('local', { projectName: 'acme', workspaceName: 'feat' });
    expect(result.ok).toBe(true);
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(listWorkspaces).toHaveBeenCalledTimes(1);
    expect(listSessions).toHaveBeenCalledTimes(1);
  });
});