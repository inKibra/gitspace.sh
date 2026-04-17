import { describe, expect, it, mock } from 'bun:test';
import type { BackendScopedWorkspaceRef } from '../../machine/multi/types.js';
import type { SessionBackend } from '../../session/backend.js';
import { createAppAgentSessionsClient } from './agent-sessions.js';
import type { AppClientContext, AppClientMulti } from './context.js';
import { toAppClientWorkspaceKey } from './refs.js';
import type { AppClientAgentSessionSummary } from './types.js';

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
    getBundleRefreshPlan: async () => {
      throw new Error('unused');
    },
    applyBundleRefresh: async () => undefined,
    getBundleConfigState: async () => {
      throw new Error('unused');
    },
    applyBundleConfigUpdate: async () => undefined,
    requestInbox: async () => undefined,
    clearInbox: async () => undefined,
    markInboxRead: async () => undefined,
    getNotificationConfig: async () => undefined,
    updateNotificationConfig: async () => undefined,
    sendReviewRequest: async () => {
      throw new Error('unused');
    },
    ...overrides,
  } as SessionBackend;
}

function makeMulti(
  backendByKey: Record<string, SessionBackend | null>,
  overrides: Partial<AppClientMulti> = {},
): AppClientMulti {
  return {
    getBackend: (backendKey) => backendByKey[backendKey] ?? null,
    createAgentSession: async (ref, title) => {
      const backend = backendByKey[ref.backendKey];
      return backend?.createAgentSession?.(ref.workspaceId, title) ?? [];
    },
    killAgentSession: async (ref) => {
      const backend = backendByKey[ref.backendKey];
      // backend.abortAgentSession is the wire-level kill command — name stays.
      return backend?.abortAgentSession?.(ref.workspaceId, ref.agentSessionId) ?? false;
    },
    stopAgentTurn: async (ref) => {
      const backend = backendByKey[ref.backendKey];
      return backend?.interruptAgentSession?.(ref.workspaceId, ref.agentSessionId) ?? false;
    },
    closeAgentSession: async (ref) => {
      const backend = backendByKey[ref.backendKey];
      return backend?.closeAgentSession?.(ref.workspaceId, ref.agentSessionId) ?? [];
    },
    archiveAgentSession: async (ref) => {
      const backend = backendByKey[ref.backendKey];
      return backend?.archiveAgentSession?.(ref.workspaceId, ref.agentSessionId) ?? [];
    },
    restoreAgentSession: async (ref) => {
      const backend = backendByKey[ref.backendKey];
      return backend?.restoreAgentSession?.(ref.workspaceId, ref.agentSessionId) ?? [];
    },
    attachAgentSession: async (ref, options) => {
      const backend = backendByKey[ref.backendKey];
      await backend?.attachAgentSession?.(ref.workspaceId, ref.agentSessionId, options);
    },
    getAgentSessionPreference: async (ref) => {
      const backend = backendByKey[ref.backendKey];
      return backend?.getAgentSessionPreference(ref.workspaceId) ?? null;
    },
    setAgentSessionPreference: async (ref, sessionId) => {
      const backend = backendByKey[ref.backendKey];
      await backend?.setAgentSessionPreference(ref.workspaceId, sessionId);
    },
    ...overrides,
  };
}

function makeContext(options: {
  workspaceRefs: BackendScopedWorkspaceRef[];
  backendByKey: Record<string, SessionBackend | null>;
  selectedWorkspaceRef?: BackendScopedWorkspaceRef | null;
  detailWorkspaceRef?: BackendScopedWorkspaceRef | null;
  preferredBackendKey?: string | null;
  agentSessionsByWorkspaceKey?: Record<string, AppClientAgentSessionSummary[] | undefined>;
  multiOverrides?: Partial<AppClientMulti>;
}): AppClientContext {
  return {
    multi: makeMulti(options.backendByKey, options.multiOverrides),
    workspaceRefs: options.workspaceRefs,
    selectedWorkspaceRef: options.selectedWorkspaceRef ?? null,
    detailWorkspaceRef: options.detailWorkspaceRef ?? null,
    preferredBackendKey: options.preferredBackendKey ?? null,
    agentSessionsByWorkspaceKey: options.agentSessionsByWorkspaceKey,
  };
}

describe('app client agent sessions', () => {
  it('opens against the detail workspace backend and swallows preference persistence failures', async () => {
    const attachAlpha = mock(async () => undefined);
    const attachBeta = mock(async () => undefined);
    const setPreference = mock(async () => {
      throw new Error('disk full');
    });

    const alpha = makeBackend({ attachAgentSession: attachAlpha });
    const beta = makeBackend({ attachAgentSession: attachBeta, setAgentSessionPreference: setPreference });
    const workspaceRef = { backendKey: 'beta', workspaceId: 'proj:ws-1' } satisfies BackendScopedWorkspaceRef;

    const client = createAppAgentSessionsClient(makeContext({
      workspaceRefs: [
        { backendKey: 'alpha', workspaceId: 'proj:ws-1' },
        workspaceRef,
      ],
      backendByKey: { alpha, beta },
      detailWorkspaceRef: workspaceRef,
    }));

    const result = await client.open({ workspaceId: 'proj:ws-1', agentSessionId: 'agent-2' });

    expect(result.ok).toBe(true);
    expect(attachAlpha).not.toHaveBeenCalled();
    expect(attachBeta).toHaveBeenCalledTimes(1);
    expect(attachBeta).toHaveBeenCalledWith('proj:ws-1', 'agent-2', undefined);
    expect(setPreference).toHaveBeenCalledTimes(1);
  });

  it('creates and opens the newly added agent session', async () => {
    const attachAgentSession = mock(async () => undefined);
    const createAgentSession = mock(async () => [
      { id: 'existing', title: 'Existing', updatedAt: '2026-03-01T00:00:00.000Z' },
      { id: 'created', title: 'Created', updatedAt: '2026-03-02T00:00:00.000Z' },
    ] satisfies AppClientAgentSessionSummary[]);

    const backend = makeBackend({
      createAgentSession,
      attachAgentSession,
    });
    const workspaceRef = { backendKey: 'local', workspaceId: 'proj:ws-1' } satisfies BackendScopedWorkspaceRef;

    const client = createAppAgentSessionsClient(makeContext({
      workspaceRefs: [workspaceRef],
      backendByKey: { local: backend },
      agentSessionsByWorkspaceKey: {
        [toAppClientWorkspaceKey(workspaceRef)]: [{ id: 'existing', title: 'Existing' }],
      },
    }));

    const result = await client.createAndOpen({ workspaceId: 'proj:ws-1', title: 'Investigate bug' });

    expect(result.ok).toBe(true);
    expect(createAgentSession).toHaveBeenCalledWith('proj:ws-1', 'Investigate bug');
    expect(attachAgentSession).toHaveBeenCalledWith('proj:ws-1', 'created', undefined);
  });

  it('falls back to the most recently updated session when create returns no new id', async () => {
    const attachAgentSession = mock(async () => undefined);
    const backend = makeBackend({
      createAgentSession: mock(async () => [
        { id: 'existing-1', title: 'One', updatedAt: '2026-03-01T00:00:00.000Z' },
        { id: 'existing-2', title: 'Two', updatedAt: '2026-03-03T00:00:00.000Z' },
      ] satisfies AppClientAgentSessionSummary[]),
      attachAgentSession,
    });
    const workspaceRef = { backendKey: 'local', workspaceId: 'proj:ws-1' } satisfies BackendScopedWorkspaceRef;

    const client = createAppAgentSessionsClient(makeContext({
      workspaceRefs: [workspaceRef],
      backendByKey: { local: backend },
      agentSessionsByWorkspaceKey: {
        [toAppClientWorkspaceKey(workspaceRef)]: [
          { id: 'existing-1', title: 'One' },
          { id: 'existing-2', title: 'Two' },
        ],
      },
    }));

    const result = await client.createAndOpen({ workspaceId: 'proj:ws-1' });

    expect(result.ok).toBe(true);
    expect(attachAgentSession).toHaveBeenCalledWith('proj:ws-1', 'existing-2', undefined);
  });

  it('returns an ambiguous-backend error when the workspace exists on multiple backends without context', async () => {
    const alpha = makeBackend({ attachAgentSession: mock(async () => undefined) });
    const beta = makeBackend({ attachAgentSession: mock(async () => undefined) });

    const client = createAppAgentSessionsClient(makeContext({
      workspaceRefs: [
        { backendKey: 'alpha', workspaceId: 'proj:ws-1' },
        { backendKey: 'beta', workspaceId: 'proj:ws-1' },
      ],
      backendByKey: { alpha, beta },
    }));

    const result = await client.open({ workspaceId: 'proj:ws-1', agentSessionId: 'agent-1' });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected ambiguous result');
    expect(result.error.code).toBe('ambiguous-backend');
    expect(result.error.candidateBackendKeys).toEqual(['alpha', 'beta']);
  });

  it('restores an agent session through the resolved backend', async () => {
    const restoreAgentSession = mock(async () => [
      { id: 'agent-1', title: 'Recovered', updatedAt: '2026-03-03T00:00:00.000Z' },
    ] satisfies AppClientAgentSessionSummary[]);
    const backend = makeBackend({ restoreAgentSession });
    const workspaceRef = { backendKey: 'remote:machine-1', workspaceId: 'proj:ws-1' } satisfies BackendScopedWorkspaceRef;

    const client = createAppAgentSessionsClient(makeContext({
      workspaceRefs: [workspaceRef],
      backendByKey: { 'remote:machine-1': backend },
      preferredBackendKey: 'remote:machine-1',
    }));

    const result = await client.restore({ workspaceId: 'proj:ws-1', agentSessionId: 'agent-1' });

    expect(result.ok).toBe(true);
    expect(restoreAgentSession).toHaveBeenCalledWith('proj:ws-1', 'agent-1');
  });
});
