import { describe, expect, it, mock } from 'bun:test';
import type { SessionBackend } from '../../session/backend.js';
import { createAppReplayReviewClient } from './replays-reviews.js';
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

function makeContext(backend: SessionBackend): AppClientContext {
  const multi: AppClientMulti = {
    getBackend: () => backend,
    createAgentSession: async () => [],
    abortAgentSession: async () => false,
    closeAgentSession: async () => [],
    archiveAgentSession: async () => [],
    restoreAgentSession: async () => [],
    attachAgentSession: async () => undefined,
    getAgentSessionPreference: async () => null,
    setAgentSessionPreference: async () => undefined,
  };
  return { multi, workspaceRefs: [] };
}

describe('app client replay/review', () => {
  it('sends review requests through backend', async () => {
    const sendReviewRequest = mock(async () => ({ ok: true } as any));
    const client = createAppReplayReviewClient(makeContext(makeBackend({ sendReviewRequest })));
    const result = await client.sendReviewRequest('local', 'proj:ws-1', { op: 'status', projectName: 'proj', workspaceName: 'proj:ws-1' } as any);
    expect(result.ok).toBe(true);
    expect(sendReviewRequest).toHaveBeenCalledTimes(1);
  });

  it('dismisses replay through backend', async () => {
    const dismissReplay = mock(async () => undefined);
    const client = createAppReplayReviewClient(makeContext(makeBackend({ dismissReplay })));
    const result = await client.dismissReplay('local', 'replay-1');
    expect(result.ok).toBe(true);
    expect(dismissReplay).toHaveBeenCalledWith('replay-1');
  });
});
