import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { renderHook } from '@testing-library/react';
import { setupTestDom, teardownTestDom } from '../../test/setup-dom.js';
import type { AppClient, AgentSessionCommandError } from '../client/index.js';
import { useWorkspaceLifecycleActions } from './useWorkspaceLifecycleActions.js';





beforeAll(() => setupTestDom());

afterAll(() => teardownTestDom());

function makeClient(overrides: Partial<AppClient['workspaceLifecycle']> = {}): AppClient {
  return {
    agentSessions: {
      open: mock(async () => ({ ok: true as const, value: { workspaceRef: { backendKey: 'local', workspaceId: 'proj:ws-1' }, agentSessionRef: { backendKey: 'local', workspaceId: 'proj:ws-1', agentSessionId: 'agent-1' } } })),
      createAndOpen: mock(async () => ({ ok: true as const, value: { workspaceRef: { backendKey: 'local', workspaceId: 'proj:ws-1' }, agentSessionRef: { backendKey: 'local', workspaceId: 'proj:ws-1', agentSessionId: 'agent-created' } } })),
      abort: mock(async () => ({ ok: true as const, value: { workspaceRef: { backendKey: 'local', workspaceId: 'proj:ws-1' }, agentSessionRef: { backendKey: 'local', workspaceId: 'proj:ws-1', agentSessionId: 'agent-1' } } })),
      close: mock(async () => ({ ok: true as const, value: { workspaceRef: { backendKey: 'local', workspaceId: 'proj:ws-1' }, agentSessionRef: { backendKey: 'local', workspaceId: 'proj:ws-1', agentSessionId: 'agent-1' } } })),
      archive: mock(async () => ({ ok: true as const, value: { workspaceRef: { backendKey: 'local', workspaceId: 'proj:ws-1' }, agentSessionRef: { backendKey: 'local', workspaceId: 'proj:ws-1', agentSessionId: 'agent-1' } } })),
      restore: mock(async () => ({ ok: true as const, value: { workspaceRef: { backendKey: 'local', workspaceId: 'proj:ws-1' }, agentSessionRef: { backendKey: 'local', workspaceId: 'proj:ws-1', agentSessionId: 'agent-1' } } })),
    },
    workspaceLifecycle: {
      setStatus: mock(async () => ({ ok: true as const, value: { workspaceRef: { backendKey: 'local', workspaceId: 'proj:ws-1' }, phase: 'review' as const } })),
      deleteWorkspace: mock(async () => ({ ok: true as const, value: { workspaceRef: { backendKey: 'local', workspaceId: 'proj:ws-1' }, params: { scriptPolicy: 'auto' as const } } })),
      ...overrides,
    },
    processes: {
      start: mock(async () => ({ ok: true as const, value: { workspaceRef: { backendKey: 'local', workspaceId: 'proj:ws-1' }, processName: 'web', instance: 1 } })),
      stop: mock(async () => ({ ok: true as const, value: { workspaceRef: { backendKey: 'local', workspaceId: 'proj:ws-1' }, processName: 'web' } })),
    },
    inbox: {
      request: mock(async () => ({ ok: true as const, value: {} })),
      clear: mock(async () => ({ ok: true as const, value: {} })),
      markRead: mock(async () => ({ ok: true as const, value: { itemId: 'item-1' } })),
      respondToPermission: mock(async () => ({ ok: true as const, value: { workspaceId: 'proj:ws-1', agentSessionId: 'agent-1', permissionId: 'perm-1', response: 'allow' as const } })),
    },
    bundles: {
      getRefreshPlan: mock(async () => ({ ok: true as const, value: {} as any })),
      applyRefresh: mock(async () => ({ ok: true as const, value: { backendKey: 'local', workspaceId: 'proj:ws-1' } })),
      getConfigState: mock(async () => ({ ok: true as const, value: {} as any })),
      applyConfigUpdate: mock(async () => ({ ok: true as const, value: { backendKey: 'local', workspaceId: 'proj:ws-1' } })),
    },
    replayReview: {
      sendReviewRequest: mock(async () => ({ ok: true as const, value: {} as any })),
      dismissReplay: mock(async () => ({ ok: true as const, value: { replayId: 'replay-1' } })),
      undismissReplay: mock(async () => ({ ok: true as const, value: { replayId: 'replay-1' } })),
      cancelReplayRequests: mock(() => undefined),
      getReplayFrame: mock(async () => ({ ok: true as const, value: {} as any })),
      getReplayTimeline: mock(async () => ({ ok: true as const, value: {} as any })),
    },
    sessions: {
      attach: mock(async () => ({ ok: true as const, value: { backendKey: 'local', workspaceId: 'proj:ws-1' } })),
      cancelPendingScripts: mock(async () => ({ ok: true as const, value: { backendKey: 'local', workspaceId: 'proj:ws-1' } })),
    },
    lifecycle: {} as any,
  };
}

describe('useWorkspaceLifecycleActions', () => {
  it('routes status changes through the client', async () => {
    const client = makeClient();
    const { result } = renderHook(() => useWorkspaceLifecycleActions({
      client,
      flow: { showLoading: () => undefined, showConfirm: () => undefined, showMessage: () => undefined, close: () => undefined },
    }));

    const ok = await result.current.setStatus({ backendKey: 'local', workspaceId: 'proj:ws-1' }, 'review');

    expect(ok).toBe(true);
    expect(client.workspaceLifecycle.setStatus).toHaveBeenCalledWith({ backendKey: 'local', workspaceId: 'proj:ws-1' }, 'review');
  });

  it('runs delete flow through the client action', async () => {
    const client = makeClient();
    const { result } = renderHook(() => useWorkspaceLifecycleActions({
      client,
      flow: {
        showLoading: () => undefined,
        showMessage: () => undefined,
        close: () => undefined,
        showConfirm: () => undefined,
      },
    }));

    const ok = await result.current.deleteWorkspaceWithPrompt({
      ref: { backendKey: 'local', workspaceId: 'proj:ws-1' },
      workspaceName: 'ws-1',
    });

    expect(ok).toBe(true);
    expect(client.workspaceLifecycle.deleteWorkspace).toHaveBeenCalledTimes(1);
  });

  it('reports lifecycle client errors to the UI layer', async () => {
    const onError = mock((_message: string, _error: AgentSessionCommandError) => undefined);
    const client = makeClient({
      setStatus: mock(async () => ({
        ok: false as const,
        error: {
          code: 'operation-unavailable' as const,
          message: 'Workspace status changes are unavailable',
          workspaceId: 'proj:ws-1',
          backendKey: 'local',
        },
      })),
    });

    const { result } = renderHook(() => useWorkspaceLifecycleActions({
      client,
      flow: { showLoading: () => undefined, showConfirm: () => undefined, showMessage: () => undefined, close: () => undefined },
      onError,
    }));

    const ok = await result.current.setStatus({ backendKey: 'local', workspaceId: 'proj:ws-1' }, 'review');

    expect(ok).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe('Failed to update workspace status: Workspace status changes are unavailable');
  });
});
